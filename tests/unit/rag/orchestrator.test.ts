import { test, expect, describe, beforeEach } from 'bun:test';
import type { RagConfig } from '../../../apps/api/src/config/rag';
import {
  answerQuestion,
  deriveThreadTitle,
  MAX_THREAD_TITLE_LENGTH,
  type OrchestratorDeps,
} from '../../../apps/api/src/rag/orchestrator';
import { createScriptedLLMProvider, scriptedError } from '../../../apps/api/src/providers/llm/scripted.mock';
import { createDeterministicEmbeddingProvider } from '../../../apps/api/src/providers/embedding/deterministic.mock';
import { createTokenizer } from '../../../apps/api/src/ingestion/tokenizer/tokenizer';
import { AppError, isAppError } from '../../../apps/api/src/errors/AppError';
import { conversations } from '../../../apps/api/src/db/schema';
import { createFakeDatabase, type ExecuteRoute } from '../../helpers/fakeDatabase';

// ---------------------------------------------------------------------------
// The whole pipeline exercised end-to-end against real orchestrator.ts, real
// contextualizer/planner/judge/answerGenerator/fusion/context code, a
// scripted LLM, the deterministic embedding provider, and an in-memory fake
// Database (see tests/helpers/fakeDatabase.ts for why this is a fake `db`
// rather than a mock.module() of the repo/retrieval modules).
// ---------------------------------------------------------------------------

// Raw rows the fake vector/keyword retrievers and chunks.repo.hydrateChunksByIds
// resolve to, keyed by the SQL marker that identifies which query fired.
const VECTOR_ROWS = [
  { id: 'chunk-1', chunk_key: 'ck-1', class_id: 'class-1', module_id: 'module-1', chunk_index: 0, score: 0.9 },
  { id: 'chunk-2', chunk_key: 'ck-2', class_id: 'class-1', module_id: 'module-1', chunk_index: 1, score: 0.8 },
];
const KEYWORD_ROWS = [
  { id: 'chunk-2', chunk_key: 'ck-2', class_id: 'class-1', module_id: 'module-1', chunk_index: 1, score: 0.5 },
  { id: 'chunk-1', chunk_key: 'ck-1', class_id: 'class-1', module_id: 'module-1', chunk_index: 0, score: 0.4 },
];
const HYDRATE_ROWS = [
  {
    id: 'chunk-1',
    text: 'Normalization organizes relational data to reduce redundancy.',
    start_ms: 0,
    end_ms: 5000,
    transcript_id: 'transcript-1',
    class_id: 'class-1',
    class_name: 'Class One',
    module_id: 'module-1',
    module_name: 'Module One',
  },
  {
    id: 'chunk-2',
    text: 'Third normal form removes transitive dependencies.',
    start_ms: 5000,
    end_ms: 10000,
    transcript_id: 'transcript-1',
    class_id: 'class-1',
    class_name: 'Class One',
    module_id: 'module-1',
    module_name: 'Module One',
  },
];

let retrievalShouldFail = false;

function executeRoutes(): ExecuteRoute[] {
  return [
    { marker: 'SET LOCAL', handler: () => ({ rows: [] }) },
    {
      marker: 'array_position',
      handler: () => ({ rows: HYDRATE_ROWS }),
    },
    {
      marker: 'embedding <=>',
      handler: () => {
        if (retrievalShouldFail) throw new Error('simulated vector retrieval failure');
        return { rows: VECTOR_ROWS };
      },
    },
    {
      marker: 'ts_rank_cd',
      handler: () => {
        if (retrievalShouldFail) throw new Error('simulated keyword retrieval failure');
        return { rows: KEYWORD_ROWS };
      },
    },
  ];
}

function ragConfig(overrides: Partial<RagConfig['features']> = {}): RagConfig {
  return {
    llm: {
      model: 'scripted-mock',
      timeoutMs: 5000,
      reasoningEffort: { contextualizer: 'low', planner: 'low', judge: 'medium', answer: 'medium' },
    },
    chunking: { version: 'v1', targetTokens: 500, minTokens: 350, maxTokens: 650, overlapRatio: 0.125, gapPreferredMs: 2000, tokenizerEncoding: 'o200k_base' },
    retrieval: { topKVector: 5, topKKeyword: 5, maxQueries: 6, maxSubQueries: 3, ftsLanguage: 'english' },
    rrf: { k: 60 },
    budgets: { contextTokens: 8000, conversationHistoryTokens: 1500 },
    index: { hnswM: 16, hnswEfConstruction: 64, hnswEfSearch: 64 },
    embedding: { model: 'deterministic-mock', dimensions: 1536, batchSize: 96 },
    features: { allowGeneralKnowledgeFallback: true, diagnosticsEnabled: false, ...overrides },
  };
}

const QUERY_PLAN = { contextualizedQuery: 'what is normalization', rewrittenQuery: null, stepBackQuery: null, subQueries: [], rationale: 'simple question' };
const SUFFICIENT_JUDGE = { verdict: 'sufficient' as const, rationale: 'covers it', supportingSourceIds: ['SOURCE_1'], conflictingSourceIds: [], missingInformation: [] };
const VALID_ANSWER = { answer: 'Normalization reduces redundancy. [SOURCE_1]', citedSourceIds: ['SOURCE_1'], usedGeneralKnowledge: false };

function deps(provider: ReturnType<typeof createScriptedLLMProvider>, config: RagConfig = ragConfig()): OrchestratorDeps {
  const { db } = createFakeDatabase({ executeRoutes: executeRoutes() });
  return {
    db,
    llm: provider,
    embeddings: createDeterministicEmbeddingProvider(),
    config,
    tokenizer: createTokenizer('o200k_base'),
  };
}

function baseInput(overrides: Partial<{ question: string; cohortId: string; userId: string; conversationId?: string }> = {}) {
  return {
    question: 'What is normalization?',
    cohortId: 'cohort-1',
    userId: 'user-1',
    ...overrides,
  };
}

beforeEach(() => {
  retrievalShouldFail = false;
});

describe('deriveThreadTitle', () => {
  test('trims and collapses whitespace', () => {
    expect(deriveThreadTitle('  How   does\nnormalization\twork?  ')).toBe('How does normalization work?');
  });

  test('truncates long questions at a word boundary with an ellipsis', () => {
    const title = deriveThreadTitle(
      'Explain how database normalization reduces duplication while preserving data integrity across related tables',
    );

    expect(title).toBe('Explain how database normalization reduces duplication while preserving…');
    expect(title.length).toBeLessThanOrEqual(MAX_THREAD_TITLE_LENGTH);
  });
});

describe('answerQuestion', () => {
  test('a new conversation uses the first question as its title', async () => {
    const { db, rowsOf } = createFakeDatabase({ executeRoutes: executeRoutes() });
    const provider = createScriptedLLMProvider({
      query_plan: [QUERY_PLAN],
      evidence_assessment: [SUFFICIENT_JUDGE],
      answer: [VALID_ANSWER],
    });

    await answerQuestion(
      {
        db,
        llm: provider,
        embeddings: createDeterministicEmbeddingProvider(),
        config: ragConfig(),
        tokenizer: createTokenizer('o200k_base'),
      },
      baseInput({ question: '  What   is\nnormalization?  ' }),
    );

    expect(rowsOf(conversations)).toHaveLength(1);
    expect(rowsOf(conversations)[0]?.title).toBe('What is normalization?');
  });

  test('happy path returns a contract-shaped ChatResponse', async () => {
    const provider = createScriptedLLMProvider({
      query_plan: [QUERY_PLAN],
      evidence_assessment: [SUFFICIENT_JUDGE],
      answer: [VALID_ANSWER],
    });

    const response = await answerQuestion(deps(provider), baseInput());

    expect(response.conversationId).toBeString();
    expect(response.messageId).toBeString();
    expect(response.answer).toBe(VALID_ANSWER.answer);
    expect(response.groundingStatus).toBe('course_grounded');
    expect(response.sources).toBeArray();
    expect(response.sources.length).toBe(1);
    expect(response.diagnostics).toBeUndefined();
  });

  test('a first turn makes ZERO contextualizer calls', async () => {
    const provider = createScriptedLLMProvider({
      query_plan: [QUERY_PLAN],
      evidence_assessment: [SUFFICIENT_JUDGE],
      answer: [VALID_ANSWER],
    });

    await answerQuestion(deps(provider), baseInput());

    expect(provider.calls.some((c) => c.schemaName === 'contextualized_query')).toBe(false);
  });

  test('a follow-up turn with history DOES call the contextualizer', async () => {
    const { db, rowsOf } = createFakeDatabase({ executeRoutes: executeRoutes() });
    const orchestratorDeps: OrchestratorDeps = {
      db,
      llm: createScriptedLLMProvider({}),
      embeddings: createDeterministicEmbeddingProvider(),
      config: ragConfig(),
      tokenizer: createTokenizer('o200k_base'),
    };

    // Create the conversation and its first turn through the real pipeline...
    const firstProvider = createScriptedLLMProvider({
      query_plan: [QUERY_PLAN],
      evidence_assessment: [SUFFICIENT_JUDGE],
      answer: [VALID_ANSWER],
    });
    const first = await answerQuestion({ ...orchestratorDeps, llm: firstProvider }, baseInput());

    // ...then ask a follow-up on the SAME conversationId.
    const secondProvider = createScriptedLLMProvider({
      contextualized_query: [{ standaloneQuery: 'What is 3NF?', usedHistory: true, resolvedReferences: ['it -> 3NF'] }],
      query_plan: [QUERY_PLAN],
      evidence_assessment: [SUFFICIENT_JUDGE],
      answer: [VALID_ANSWER],
    });
    await answerQuestion(
      { ...orchestratorDeps, llm: secondProvider },
      baseInput({ conversationId: first.conversationId, question: 'what about it?' }),
    );

    expect(secondProvider.calls.some((c) => c.schemaName === 'contextualized_query')).toBe(true);
    expect(rowsOf(conversations)[0]?.title).toBe('What is normalization?');
  });

  test('diagnostics present only when config.features.diagnosticsEnabled is true', async () => {
    const providerOn = createScriptedLLMProvider({
      query_plan: [QUERY_PLAN],
      evidence_assessment: [SUFFICIENT_JUDGE],
      answer: [VALID_ANSWER],
    });
    const onResponse = await answerQuestion(deps(providerOn, ragConfig({ diagnosticsEnabled: true })), baseInput());
    expect(onResponse.diagnostics).toBeDefined();
    expect(onResponse.diagnostics?.judgeVerdict).toBe('sufficient');
    expect(onResponse.diagnostics?.fusedCount).toBe(2);
    // RRF tie-break is chunkId asc (spec §11) → chunk-1 before chunk-2.
    expect(onResponse.diagnostics?.fusedChunkIds).toEqual(['chunk-1', 'chunk-2']);
    expect(onResponse.diagnostics?.latencyMs.total).toBeGreaterThanOrEqual(0);

    const providerOff = createScriptedLLMProvider({
      query_plan: [QUERY_PLAN],
      evidence_assessment: [SUFFICIENT_JUDGE],
      answer: [VALID_ANSWER],
    });
    const offResponse = await answerQuestion(deps(providerOff, ragConfig({ diagnosticsEnabled: false })), baseInput());
    expect(offResponse.diagnostics).toBeUndefined();
  });

  test('contextualizer failure degrades to the raw question without failing the request', async () => {
    const { db } = createFakeDatabase({ executeRoutes: executeRoutes() });
    const orchestratorDeps: OrchestratorDeps = {
      db,
      llm: createScriptedLLMProvider({}),
      embeddings: createDeterministicEmbeddingProvider(),
      config: ragConfig(),
      tokenizer: createTokenizer('o200k_base'),
    };

    const firstProvider = createScriptedLLMProvider({
      query_plan: [QUERY_PLAN],
      evidence_assessment: [SUFFICIENT_JUDGE],
      answer: [VALID_ANSWER],
    });
    const first = await answerQuestion({ ...orchestratorDeps, llm: firstProvider }, baseInput());

    const provider = createScriptedLLMProvider({
      contextualized_query: [scriptedError(new Error('upstream blew up'))],
      query_plan: [QUERY_PLAN],
      evidence_assessment: [SUFFICIENT_JUDGE],
      answer: [VALID_ANSWER],
    });

    const response = await answerQuestion(
      { ...orchestratorDeps, llm: provider },
      baseInput({ conversationId: first.conversationId, question: 'what about it?' }),
    );

    expect(response.answer).toBe(VALID_ANSWER.answer);
    expect(provider.calls.some((c) => c.schemaName === 'contextualized_query')).toBe(true);
  });

  test('planner failure degrades to a single-query plan without failing the request', async () => {
    const provider = createScriptedLLMProvider({
      query_plan: [scriptedError(new Error('upstream blew up'))],
      evidence_assessment: [SUFFICIENT_JUDGE],
      answer: [VALID_ANSWER],
    });

    const response = await answerQuestion(deps(provider), baseInput());

    expect(response.answer).toBe(VALID_ANSWER.answer);
  });

  test('judge failure degrades to a conservative verdict without failing the request', async () => {
    const provider = createScriptedLLMProvider({
      query_plan: [QUERY_PLAN],
      evidence_assessment: [scriptedError(new Error('upstream blew up'))],
      answer: [VALID_ANSWER],
    });

    const response = await answerQuestion(deps(provider), baseInput());

    // Non-empty evidence + judge failure -> 'partial' (judge.ts's conservative
    // fallback) -> 'partially_grounded' once a valid citation survives.
    expect(response.groundingStatus).toBe('partially_grounded');
  });

  test('both retrievers failing yields RETRIEVAL_FAILED', async () => {
    retrievalShouldFail = true;
    const provider = createScriptedLLMProvider({ query_plan: [QUERY_PLAN] });

    let thrown: unknown;
    try {
      await answerQuestion(deps(provider), baseInput());
    } catch (error) {
      thrown = error;
    }

    expect(isAppError(thrown)).toBe(true);
    expect((thrown as AppError).code).toBe('RETRIEVAL_FAILED');
  });

  test('an unknown conversationId scoped to this user/cohort raises CONVERSATION_NOT_FOUND', async () => {
    const provider = createScriptedLLMProvider({});

    let thrown: unknown;
    try {
      await answerQuestion(deps(provider), baseInput({ conversationId: 'does-not-exist' }));
    } catch (error) {
      thrown = error;
    }

    expect(isAppError(thrown)).toBe(true);
    expect((thrown as AppError).code).toBe('CONVERSATION_NOT_FOUND');
  });

  test('a fabricated citation never reaches sources', async () => {
    const provider = createScriptedLLMProvider({
      query_plan: [QUERY_PLAN],
      evidence_assessment: [SUFFICIENT_JUDGE],
      // Both attempts cite a source id absent from the evidence map, forcing
      // the strip-and-downgrade path (citationValidator + answerGenerator).
      answer: [
        { answer: 'Bogus claim. [SOURCE_99]', citedSourceIds: ['SOURCE_99'], usedGeneralKnowledge: false },
        { answer: 'Still bogus. [SOURCE_99]', citedSourceIds: ['SOURCE_99'], usedGeneralKnowledge: false },
      ],
    });

    const response = await answerQuestion(deps(provider), baseInput());

    expect(response.sources.every((s) => s.id !== 'SOURCE_99')).toBe(true);
    expect(response.answer).not.toContain('SOURCE_99');
    expect(response.groundingStatus).toBe('general_knowledge');
  });

  test('every Source field comes from the evidence map', async () => {
    const provider = createScriptedLLMProvider({
      query_plan: [QUERY_PLAN],
      evidence_assessment: [SUFFICIENT_JUDGE],
      answer: [VALID_ANSWER],
    });

    const response = await answerQuestion(deps(provider), baseInput());
    const [source] = response.sources;

    expect(source).toBeDefined();
    expect(source?.id).toBe('SOURCE_1');
    expect(source?.chunkId).toBe('chunk-1');
    expect(source?.transcriptId).toBe('transcript-1');
    expect(source?.moduleId).toBe('module-1');
    expect(source?.moduleName).toBe('Module One');
    expect(source?.classId).toBe('class-1');
    expect(source?.className).toBe('Class One');
    expect(source?.startMs).toBe(0);
    expect(source?.endMs).toBe(5000);
    expect(source?.excerpt).toBe(HYDRATE_ROWS[0]?.text);
  });
});
