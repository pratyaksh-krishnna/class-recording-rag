import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import type { Pool } from 'pg';
import { runMigrations } from '../../../apps/api/migrations/run';
import { createPool, createDb, closePool, type Database } from '../../../apps/api/src/db/client';
import { createApp } from '../../../apps/api/src/app';
import { withTestServer } from '../../helpers/testServer';
import { assertTestDatabase } from '../../helpers/assertTestDatabase';
import { upsertCohort } from '../../../apps/api/src/db/repositories/cohorts.repo';
import { upsertModule } from '../../../apps/api/src/db/repositories/modules.repo';
import { upsertClass } from '../../../apps/api/src/db/repositories/classes.repo';
import { upsertTranscript } from '../../../apps/api/src/db/repositories/transcripts.repo';
import { bulkInsertChunks, setChunkEmbeddings, type ChunkInsert } from '../../../apps/api/src/db/repositories/chunks.repo';
import { createDeterministicEmbeddingProvider } from '../../../apps/api/src/providers/embedding/deterministic.mock';
import { createScriptedLLMProvider } from '../../../apps/api/src/providers/llm/scripted.mock';
import { createTokenizer } from '../../../apps/api/src/ingestion/tokenizer/tokenizer';
import type { RagConfig } from '../../../apps/api/src/config/rag';
import type {
  ApiErrorBody,
  ChatResponse,
  ConversationDetailResponse,
  ConversationListResponse,
} from '../../../packages/shared/src/contracts';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const CHUNKING_VERSION = 'v1';
const EMBEDDING_MODEL = 'deterministic-mock';
const embeddings = createDeterministicEmbeddingProvider({ model: EMBEDDING_MODEL, dimensions: 1536 });

function ragConfig(overrides: Partial<RagConfig['features']> = {}): RagConfig {
  return {
    llm: {
      model: 'scripted-mock',
      timeoutMs: 5000,
      reasoningEffort: { contextualizer: 'low', planner: 'low', judge: 'medium', answer: 'medium' },
    },
    chunking: {
      version: CHUNKING_VERSION,
      targetTokens: 500,
      minTokens: 350,
      maxTokens: 650,
      overlapRatio: 0.125,
      gapPreferredMs: 2000,
      tokenizerEncoding: 'o200k_base',
    },
    retrieval: { topKVector: 5, topKKeyword: 5, maxQueries: 6, maxSubQueries: 3, ftsLanguage: 'english' },
    rrf: { k: 60 },
    budgets: { contextTokens: 8000, conversationHistoryTokens: 1500 },
    index: { hnswM: 16, hnswEfConstruction: 64, hnswEfSearch: 40 },
    embedding: { model: EMBEDDING_MODEL, dimensions: 1536, batchSize: 96 },
    features: { allowGeneralKnowledgeFallback: true, diagnosticsEnabled: false, ...overrides },
  };
}

function chunkFixture(
  overrides: Partial<ChunkInsert> &
    Pick<ChunkInsert, 'transcriptId' | 'cohortId' | 'moduleId' | 'classId' | 'chunkKey' | 'chunkIndex' | 'text'>,
): ChunkInsert {
  return {
    startMs: overrides.chunkIndex * 1000,
    endMs: overrides.chunkIndex * 1000 + 5000,
    tokenCount: 20,
    sentenceCount: 1,
    overlapSentenceCount: 0,
    chunkingVersion: CHUNKING_VERSION,
    tokenizer: 'o200k_base',
    embeddingModel: EMBEDDING_MODEL,
    embeddingDimensions: 1536,
    ...overrides,
  };
}

const QUERY_PLAN = {
  contextualizedQuery: 'what is normalization',
  rewrittenQuery: null,
  stepBackQuery: null,
  subQueries: [],
  rationale: 'simple question',
};
const SUFFICIENT_JUDGE = {
  verdict: 'sufficient' as const,
  rationale: 'covers it',
  supportingSourceIds: ['SOURCE_1'],
  conflictingSourceIds: [],
  missingInformation: [],
};
const VALID_ANSWER = {
  answer: 'Normalization reduces redundancy by organizing data. [SOURCE_1]',
  citedSourceIds: ['SOURCE_1'],
  usedGeneralKnowledge: false,
};

describeDb('chat routes', () => {
  const url = TEST_DATABASE_URL as string;
  let pool: Pool;
  let db: Database;

  let cohortAId: string;
  let cohortBId: string;
  const chunkIds: Record<string, string> = {};

  async function embedAndSet(id: string, text: string) {
    const [embedding] = await embeddings.embed([text]);
    if (!embedding) throw new Error('provider returned no embedding');
    const updated = await setChunkEmbeddings(db, [{ id, embedding }]);
    if (updated !== 1) throw new Error(`expected to embed chunk ${id}, updated ${updated} rows`);
  }

  beforeAll(async () => {
    assertTestDatabase(url);
    await runMigrations(url);
    pool = createPool(url);
    db = createDb(pool);
    await pool.query('TRUNCATE cohorts CASCADE');

    // Cohort A and cohort B share near-identical wording, on purpose (same
    // trick as tests/integration/rag/retrieval.test.ts) so a cohort filter
    // that leaked would actually be exercised, not just untested.
    const normalizationText = 'Normalization organizes relational data to reduce redundancy across tables.';

    const cohortA = await upsertCohort(db, { slug: 'chat-cohort-a', name: 'Chat Cohort A' });
    cohortAId = cohortA.id;
    const moduleA = await upsertModule(db, { cohortId: cohortAId, slug: 'module-a', name: 'Module A', position: 1 });
    const classA = await upsertClass(db, { cohortId: cohortAId, moduleId: moduleA.id, slug: 'class-a', name: 'Class A', position: 1 });
    const transcriptA = await upsertTranscript(db, {
      cohortId: cohortAId,
      moduleId: moduleA.id,
      classId: classA.id,
      format: 'vtt',
      sourceUri: 'recordings/chat-a.vtt',
      contentHash: 'chat-hash-a',
      byteSize: 10,
    });

    const cohortB = await upsertCohort(db, { slug: 'chat-cohort-b', name: 'Chat Cohort B' });
    cohortBId = cohortB.id;
    const moduleB = await upsertModule(db, { cohortId: cohortBId, slug: 'module-b', name: 'Module B', position: 1 });
    const classB = await upsertClass(db, { cohortId: cohortBId, moduleId: moduleB.id, slug: 'class-b', name: 'Class B', position: 1 });
    const transcriptB = await upsertTranscript(db, {
      cohortId: cohortBId,
      moduleId: moduleB.id,
      classId: classB.id,
      format: 'vtt',
      sourceUri: 'recordings/chat-b.vtt',
      contentHash: 'chat-hash-b',
      byteSize: 10,
    });

    const rows: ChunkInsert[] = [
      chunkFixture({ transcriptId: transcriptA.id, cohortId: cohortAId, moduleId: moduleA.id, classId: classA.id, chunkKey: 'chat-a:norm', chunkIndex: 0, text: normalizationText }),
      chunkFixture({ transcriptId: transcriptB.id, cohortId: cohortBId, moduleId: moduleB.id, classId: classB.id, chunkKey: 'chat-b:norm', chunkIndex: 0, text: normalizationText }),
    ];
    await bulkInsertChunks(db, rows);

    const byKey = await pool.query<{ id: string; chunk_key: string }>(
      "SELECT id, chunk_key FROM chunks WHERE chunk_key LIKE 'chat-%'",
    );
    for (const row of byKey.rows) chunkIds[row.chunk_key] = row.id;

    await embedAndSet(chunkIds['chat-a:norm']!, normalizationText);
    await embedAndSet(chunkIds['chat-b:norm']!, normalizationText);
  });

  afterAll(async () => {
    await pool.query('TRUNCATE cohorts CASCADE');
    await closePool(pool);
  });

  function buildApp(llm: ReturnType<typeof createScriptedLLMProvider>, config: RagConfig = ragConfig()) {
    return createApp({
      pool,
      db,
      llm,
      embeddings,
      tokenizer: createTokenizer('o200k_base'),
      ragConfig: config,
    });
  }

  function chatHeaders(userId: string, cohortId: string): Record<string, string> {
    return { 'content-type': 'application/json', 'x-user-id': userId, 'x-cohort-id': cohortId };
  }

  test('missing x-cohort-id header is rejected as 400 VALIDATION_ERROR', async () => {
    const app = buildApp(createScriptedLLMProvider({}));
    await withTestServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': 'user-1' },
        body: JSON.stringify({ question: 'What is normalization?' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiErrorBody;
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(body)).not.toContain('stack');
    });
  });

  test('a valid question returns 200 with the ChatResponse contract shape', async () => {
    const llm = createScriptedLLMProvider({
      query_plan: [QUERY_PLAN],
      evidence_assessment: [SUFFICIENT_JUDGE],
      answer: [VALID_ANSWER],
    });
    const app = buildApp(llm);
    await withTestServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: chatHeaders('user-1', cohortAId),
        body: JSON.stringify({ question: 'What is normalization?' }),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ChatResponse;
      expect(body.conversationId).toBeString();
      expect(body.messageId).toBeString();
      expect(body.answer).toBe(VALID_ANSWER.answer);
      expect(body.groundingStatus).toBe('course_grounded');
      expect(body.sources).toBeArray();
      expect(body.sources.length).toBeGreaterThan(0);
      expect(body.sources[0]?.chunkId).toBe(chunkIds['chat-a:norm']);
      expect(body.diagnostics).toBeUndefined();
    });
  });

  test('the conversation and messages persist, and a follow-up reuses the same conversation', async () => {
    const firstLlm = createScriptedLLMProvider({
      query_plan: [QUERY_PLAN],
      evidence_assessment: [SUFFICIENT_JUDGE],
      answer: [VALID_ANSWER],
    });
    const app = buildApp(firstLlm);

    await withTestServer(app, async (baseUrl) => {
      const firstRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: chatHeaders('user-2', cohortAId),
        body: JSON.stringify({ question: 'What is normalization?' }),
      });
      expect(firstRes.status).toBe(200);
      const first = (await firstRes.json()) as ChatResponse;

      // Second turn reuses the conversation and, with history now present,
      // exercises the contextualizer too.
      const secondLlm = createScriptedLLMProvider({
        contextualized_query: [{ standaloneQuery: 'What is 3NF?', usedHistory: true, resolvedReferences: ['it -> 3NF'] }],
        query_plan: [QUERY_PLAN],
        evidence_assessment: [SUFFICIENT_JUDGE],
        answer: [{ answer: 'Third normal form builds on normalization. [SOURCE_1]', citedSourceIds: ['SOURCE_1'], usedGeneralKnowledge: false }],
      });
      const secondApp = buildApp(secondLlm);
      await withTestServer(secondApp, async (secondBaseUrl) => {
        const secondRes = await fetch(`${secondBaseUrl}/api/chat`, {
          method: 'POST',
          headers: chatHeaders('user-2', cohortAId),
          body: JSON.stringify({ question: 'what about it?', conversationId: first.conversationId }),
        });
        expect(secondRes.status).toBe(200);
        const second = (await secondRes.json()) as ChatResponse;
        expect(second.conversationId).toBe(first.conversationId);
        expect(secondLlm.calls.some((c) => c.schemaName === 'contextualized_query')).toBe(true);
      });

      const getRes = await fetch(`${baseUrl}/api/conversations/${first.conversationId}`, {
        headers: chatHeaders('user-2', cohortAId),
      });
      expect(getRes.status).toBe(200);
      const conversation = (await getRes.json()) as ConversationDetailResponse;
      expect(conversation.messages.length).toBe(4);
      expect(conversation.messages.filter((m) => m.role === 'user').length).toBe(2);
      expect(conversation.messages.filter((m) => m.role === 'assistant').length).toBe(2);
      const assistantMessages = conversation.messages.filter((m) => m.role === 'assistant');
      expect(assistantMessages.every((m) => m.sources.length > 0)).toBe(true);
      expect(conversation.messages.filter((m) => m.role === 'user').every((m) => m.sources.length === 0)).toBe(true);
      expect(conversation.messages.every((m) => typeof m.createdAt === 'string' && !Number.isNaN(Date.parse(m.createdAt)))).toBe(true);

      const listRes = await fetch(`${baseUrl}/api/conversations`, { headers: chatHeaders('user-2', cohortAId) });
      expect(listRes.status).toBe(200);
      const listing = (await listRes.json()) as ConversationListResponse;
      expect(listing.conversations.some((c) => c.id === first.conversationId)).toBe(true);
      expect(listing.conversations.every((c) => typeof c.createdAt === 'string' && typeof c.updatedAt === 'string')).toBe(true);
    });
  });

  test('a cohort A caller never receives cohort B content, even with matching wording', async () => {
    const llm = createScriptedLLMProvider({
      query_plan: [QUERY_PLAN],
      evidence_assessment: [SUFFICIENT_JUDGE],
      answer: [VALID_ANSWER],
    });
    const app = buildApp(llm);
    await withTestServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: chatHeaders('user-3', cohortAId),
        body: JSON.stringify({ question: 'What is normalization?' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ChatResponse;

      for (const source of body.sources) {
        expect(source.chunkId).not.toBe(chunkIds['chat-b:norm']);
      }
    });
  });

  test('an unknown conversationId returns 404 CONVERSATION_NOT_FOUND', async () => {
    const llm = createScriptedLLMProvider({});
    const app = buildApp(llm);
    await withTestServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: chatHeaders('user-1', cohortAId),
        body: JSON.stringify({ question: 'What is normalization?', conversationId: '00000000-0000-0000-0000-000000000000' }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as ApiErrorBody;
      expect(body.error.code).toBe('CONVERSATION_NOT_FOUND');
      expect(JSON.stringify(body)).not.toContain('stack');
    });
  });

  test('GET /api/conversations/:id returns hydrated Source objects ordered by citation rank', async () => {
    const llm = createScriptedLLMProvider({
      query_plan: [QUERY_PLAN],
      evidence_assessment: [SUFFICIENT_JUDGE],
      answer: [VALID_ANSWER],
    });
    const app = buildApp(llm);
    await withTestServer(app, async (baseUrl) => {
      const chatRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: chatHeaders('hydrate-user', cohortAId),
        body: JSON.stringify({ question: 'What is normalization?' }),
      });
      expect(chatRes.status).toBe(200);
      const chat = (await chatRes.json()) as ChatResponse;

      const getRes = await fetch(`${baseUrl}/api/conversations/${chat.conversationId}`, {
        headers: chatHeaders('hydrate-user', cohortAId),
      });
      expect(getRes.status).toBe(200);
      const detail = (await getRes.json()) as ConversationDetailResponse;

      const userMsg = detail.messages.find((m) => m.role === 'user');
      expect(userMsg?.sources).toEqual([]);

      const assistantMsg = detail.messages.find((m) => m.role === 'assistant');
      expect(assistantMsg?.sources.length).toBeGreaterThan(0);
      const source = assistantMsg!.sources[0]!;
      expect(source.id).toBe('SOURCE_1');
      expect(source.chunkId).toBe(chunkIds['chat-a:norm']!);
      expect(source.moduleName).toBe('Module A');
      expect(source.className).toBe('Class A');
      expect(source.startTime).toBe('00:00');
      expect(source.endTime).toBe('00:05');
      expect(source.startMs).toBe(0);
      expect(source.endMs).toBe(5000);
      expect(source.excerpt.length).toBeGreaterThan(0);
      expect(typeof assistantMsg!.createdAt).toBe('string');
    });
  });

  test('GET /api/conversations/:id returns 404 when scoped to a different user or cohort', async () => {
    const llm = createScriptedLLMProvider({
      query_plan: [QUERY_PLAN],
      evidence_assessment: [SUFFICIENT_JUDGE],
      answer: [VALID_ANSWER],
    });
    const app = buildApp(llm);
    await withTestServer(app, async (baseUrl) => {
      const chatRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: chatHeaders('isolation-user', cohortAId),
        body: JSON.stringify({ question: 'What is normalization?' }),
      });
      expect(chatRes.status).toBe(200);
      const chat = (await chatRes.json()) as ChatResponse;

      const wrongUser = await fetch(`${baseUrl}/api/conversations/${chat.conversationId}`, {
        headers: chatHeaders('someone-else', cohortAId),
      });
      expect(wrongUser.status).toBe(404);
      const wrongUserBody = (await wrongUser.json()) as ApiErrorBody;
      expect(wrongUserBody.error.code).toBe('CONVERSATION_NOT_FOUND');

      const wrongCohort = await fetch(`${baseUrl}/api/conversations/${chat.conversationId}`, {
        headers: chatHeaders('isolation-user', cohortBId),
      });
      expect(wrongCohort.status).toBe(404);
      const wrongCohortBody = (await wrongCohort.json()) as ApiErrorBody;
      expect(wrongCohortBody.error.code).toBe('CONVERSATION_NOT_FOUND');
    });
  });

  test('no error body contains a stack trace, across validation and not-found errors', async () => {
    const app = buildApp(createScriptedLLMProvider({}));
    await withTestServer(app, async (baseUrl) => {
      const invalidQuestion = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: chatHeaders('user-1', cohortAId),
        body: JSON.stringify({ question: '' }),
      });
      expect(invalidQuestion.status).toBe(400);
      expect(JSON.stringify(await invalidQuestion.json())).not.toContain('stack');

      const missingConversation = await fetch(`${baseUrl}/api/conversations/00000000-0000-0000-0000-000000000000`, {
        headers: chatHeaders('user-1', cohortAId),
      });
      expect(missingConversation.status).toBe(404);
      expect(JSON.stringify(await missingConversation.json())).not.toContain('stack');
    });
  });
});
