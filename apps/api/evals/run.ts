/**
 * Development-time eval harness (spec §19). Runs the real RAG pipeline against
 * dataset.yaml, prints a console summary, and writes a timestamped JSON artifact
 * for diffing runs after chunking, prompt, or k changes.
 */
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { GROUNDING_STATUSES, type ChatResponse, type GroundingStatus } from '@rag/shared';
import { eq } from 'drizzle-orm';
import { loadEnv } from '../src/config/env.schema';
import { buildRagConfig, type RagConfig } from '../src/config/rag';
import { createPool, createDb, closePool } from '../src/db/client';
import { classes, chunks } from '../src/db/schema';
import { findCohortBySlug } from '../src/db/repositories/cohorts.repo';
import { appendMessage, createConversation } from '../src/db/repositories/conversations.repo';
import { createOpenAIEmbeddingProvider } from '../src/providers/embedding/openai.embedding';
import { createOpenAILLMProvider } from '../src/providers/llm/openai.llm';
import { createTokenizer } from '../src/ingestion/tokenizer/tokenizer';
import { answerQuestion, type OrchestratorDeps } from '../src/rag/orchestrator';
import { confusionMatrix, mrr, ndcgAtK, recallAtK } from './metrics';

const EVAL_USER_ID = '00000000-0000-4000-8000-000000000001';
const COHORT_SLUG = 'react-native';
const CITATION_MARKER = /\[SOURCE_(\d+)\]/g;

interface PriorTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface EvalQuestion {
  id: string;
  category: string;
  question: string;
  priorTurns: PriorTurn[];
  expectedClassSlugs: string[];
  expectedChunkKeys?: string[];
  expectedGrounding: GroundingStatus;
  notes?: string;
}

interface RetrievalScores {
  recallAt5: number;
  recallAt10: number;
  recallAt20: number;
  mrr: number;
  ndcgAt10: number;
  chunkRecallAt5?: number;
  chunkRecallAt10?: number;
  chunkRecallAt20?: number;
}

interface QuestionResult {
  id: string;
  category: string;
  expectedGrounding: GroundingStatus;
  predictedGrounding: GroundingStatus | null;
  retrieval: RetrievalScores;
  citationBugCount: number;
  retrievedClassSlugs: string[];
  expectedClassSlugs: string[];
  error?: string;
}

interface EvalOutput {
  runAt: string;
  questionCount: number;
  results: QuestionResult[];
  aggregates: {
    retrieval: {
      meanRecallAt5: number;
      meanRecallAt10: number;
      meanRecallAt20: number;
      meanMrr: number;
      meanNdcgAt10: number;
    };
    answerability: ReturnType<typeof confusionMatrix>;
    citationBugCount: number;
    errorCount: number;
  };
}

function requireSecrets(): { databaseUrl: string; openaiApiKey: string } {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const openaiApiKey = process.env.OPENAI_API_KEY?.trim();
  const missing: string[] = [];
  if (!databaseUrl) missing.push('DATABASE_URL');
  if (!openaiApiKey) missing.push('OPENAI_API_KEY');
  if (missing.length > 0) {
    console.error(
      `Eval harness cannot run: missing ${missing.join(' and ')}.\n` +
        'Set both in .env or your shell environment, then re-run `bun run eval`.',
    );
    process.exit(1);
  }
  return { databaseUrl: databaseUrl!, openaiApiKey: openaiApiKey! };
}

async function loadDataset(datasetPath: string): Promise<EvalQuestion[]> {
  const text = await Bun.file(datasetPath).text();
  const parsed = Bun.YAML.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`dataset.yaml must be a YAML array; got ${typeof parsed}`);
  }
  return parsed as EvalQuestion[];
}

function countCitationBugs(answer: string, sources: ChatResponse['sources']): number {
  const validIds = new Set(sources.map((source) => source.id));
  let bugs = 0;
  for (const match of answer.matchAll(CITATION_MARKER)) {
    const sourceNumber = match[1];
    if (sourceNumber === undefined) continue;
    const sourceId = `SOURCE_${sourceNumber}`;
    if (!validIds.has(sourceId)) bugs += 1;
  }
  return bugs;
}

/**
 * Spec §19.2 scores Recall@K/MRR/nDCG over the post-RRF fused list, not the
 * smaller post-generation cited subset in sources[]. diagnostics.fusedChunkIds
 * is that list in rank order; walk it in array order (never Map iteration) so
 * MRR and nDCG stay rank-sensitive. The harness forces diagnosticsEnabled; the
 * sources[] fallback is a safety net — if it fires, retrieval numbers are not
 * comparable to other runs.
 */
export function retrievedClassSlugsFromResponse(
  response: ChatResponse,
  chunkIdToClassSlug: Map<string, string>,
): string[] {
  const chunkIds =
    response.diagnostics?.fusedChunkIds ?? response.sources.map((source) => source.chunkId);
  return chunkIds
    .map((chunkId) => chunkIdToClassSlug.get(chunkId))
    .filter((slug): slug is string => slug !== undefined);
}

export function retrievedChunkKeysFromResponse(
  response: ChatResponse,
  chunkIdToKey: Map<string, string>,
): string[] {
  const chunkIds =
    response.diagnostics?.fusedChunkIds ?? response.sources.map((source) => source.chunkId);
  return chunkIds
    .map((chunkId) => chunkIdToKey.get(chunkId))
    .filter((key): key is string => key !== undefined);
}

export function scoreRetrieval(
  retrievedClasses: string[],
  expectedClasses: string[],
  retrievedChunks: string[],
  expectedChunks: string[],
): RetrievalScores {
  const scores: RetrievalScores = {
    recallAt5: recallAtK(retrievedClasses, expectedClasses, 5),
    recallAt10: recallAtK(retrievedClasses, expectedClasses, 10),
    recallAt20: recallAtK(retrievedClasses, expectedClasses, 20),
    mrr: mrr(retrievedClasses, expectedClasses),
    ndcgAt10: ndcgAtK(retrievedClasses, expectedClasses, 10),
  };

  if (expectedChunks.length > 0) {
    scores.chunkRecallAt5 = recallAtK(retrievedChunks, expectedChunks, 5);
    scores.chunkRecallAt10 = recallAtK(retrievedChunks, expectedChunks, 10);
    scores.chunkRecallAt20 = recallAtK(retrievedChunks, expectedChunks, 20);
  }

  return scores;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function main(): Promise<void> {
  requireSecrets();
  const env = loadEnv(process.env);
  const baseConfig = buildRagConfig(env);
  const evalConfig: RagConfig = {
    ...baseConfig,
    features: {
      ...baseConfig.features,
      diagnosticsEnabled: true,
    },
  };

  const pool = createPool(env.DATABASE_URL, env.DB_POOL_MAX);
  const db = createDb(pool);

  const cohort = await findCohortBySlug(db, COHORT_SLUG);
  if (cohort === null) {
    console.error(
      `Eval harness cannot run: cohort slug "${COHORT_SLUG}" was not found.\n` +
        'Seed the database first (`bun run seed:transcripts`).',
    );
    await closePool(pool);
    process.exit(1);
  }

  const classRows = await db
    .select({ id: classes.id, slug: classes.slug })
    .from(classes)
    .where(eq(classes.cohortId, cohort.id));

  const classIdToSlug = new Map(classRows.map((row) => [row.id, row.slug]));

  const chunkRows = await db
    .select({ id: chunks.id, chunkKey: chunks.chunkKey, classId: chunks.classId })
    .from(chunks)
    .where(eq(chunks.cohortId, cohort.id));

  const chunkIdToKey = new Map(chunkRows.map((row) => [row.id, row.chunkKey]));
  const chunkIdToClassSlug = new Map<string, string>();
  for (const row of chunkRows) {
    const slug = classIdToSlug.get(row.classId);
    if (slug !== undefined) chunkIdToClassSlug.set(row.id, slug);
  }

  const datasetPath = resolve(import.meta.dir, 'dataset.yaml');
  const questions = await loadDataset(datasetPath);

  const embeddings = createOpenAIEmbeddingProvider({
    apiKey: env.OPENAI_API_KEY,
    model: evalConfig.embedding.model,
    dimensions: evalConfig.embedding.dimensions,
    batchSize: evalConfig.embedding.batchSize,
    timeoutMs: env.LLM_TIMEOUT_MS,
  });

  const llm = createOpenAILLMProvider({
    apiKey: env.OPENAI_API_KEY,
    model: evalConfig.llm.model,
  });

  const tokenizer = createTokenizer(evalConfig.chunking.tokenizerEncoding);

  const deps: OrchestratorDeps = {
    db,
    llm,
    embeddings,
    config: evalConfig,
    tokenizer,
  };

  const results: QuestionResult[] = [];

  for (let index = 0; index < questions.length; index += 1) {
    const entry = questions[index];
    if (entry === undefined) continue;

    process.stdout.write(`[${index + 1}/${questions.length}] ${entry.id} … `);

    try {
      const { id: conversationId } = await createConversation(db, {
        cohortId: cohort.id,
        userId: EVAL_USER_ID,
      });

      for (const turn of entry.priorTurns) {
        await appendMessage(db, {
          conversationId,
          role: turn.role,
          content: turn.content,
        });
      }

      const response = await answerQuestion(deps, {
        question: entry.question,
        cohortId: cohort.id,
        userId: EVAL_USER_ID,
        conversationId,
      });

      const retrievedClasses = retrievedClassSlugsFromResponse(response, chunkIdToClassSlug);
      const retrievedChunks = retrievedChunkKeysFromResponse(response, chunkIdToKey);
      const expectedChunks = entry.expectedChunkKeys ?? [];

      results.push({
        id: entry.id,
        category: entry.category,
        expectedGrounding: entry.expectedGrounding,
        predictedGrounding: response.groundingStatus,
        retrieval: scoreRetrieval(
          retrievedClasses,
          entry.expectedClassSlugs,
          retrievedChunks,
          expectedChunks,
        ),
        citationBugCount: countCitationBugs(response.answer, response.sources),
        retrievedClassSlugs: retrievedClasses,
        expectedClassSlugs: entry.expectedClassSlugs,
      });

      console.log(`${response.groundingStatus} (R@5=${results.at(-1)!.retrieval.recallAt5.toFixed(2)})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        id: entry.id,
        category: entry.category,
        expectedGrounding: entry.expectedGrounding,
        predictedGrounding: null,
        retrieval: {
          recallAt5: 0,
          recallAt10: 0,
          recallAt20: 0,
          mrr: 0,
          ndcgAt10: 0,
        },
        citationBugCount: 0,
        retrievedClassSlugs: [],
        expectedClassSlugs: entry.expectedClassSlugs,
        error: message,
      });
      console.log(`ERROR: ${message}`);
    }
  }

  const successful = results.filter((result) => result.error === undefined);
  const answerabilityPairs = successful
    .filter((result) => result.predictedGrounding !== null)
    .map((result) => ({
      expected: result.expectedGrounding,
      predicted: result.predictedGrounding as string,
    }));

  const output: EvalOutput = {
    runAt: new Date().toISOString(),
    questionCount: questions.length,
    results,
    aggregates: {
      retrieval: {
        meanRecallAt5: mean(successful.map((result) => result.retrieval.recallAt5)),
        meanRecallAt10: mean(successful.map((result) => result.retrieval.recallAt10)),
        meanRecallAt20: mean(successful.map((result) => result.retrieval.recallAt20)),
        meanMrr: mean(successful.map((result) => result.retrieval.mrr)),
        meanNdcgAt10: mean(successful.map((result) => result.retrieval.ndcgAt10)),
      },
      answerability: confusionMatrix(answerabilityPairs, GROUNDING_STATUSES),
      citationBugCount: results.reduce((sum, result) => sum + result.citationBugCount, 0),
      errorCount: results.filter((result) => result.error !== undefined).length,
    },
  };

  console.log('\n--- Retrieval (class-level, mean over successful questions) ---');
  console.table({
    'Recall@5': output.aggregates.retrieval.meanRecallAt5.toFixed(3),
    'Recall@10': output.aggregates.retrieval.meanRecallAt10.toFixed(3),
    'Recall@20': output.aggregates.retrieval.meanRecallAt20.toFixed(3),
    MRR: output.aggregates.retrieval.meanMrr.toFixed(3),
    'nDCG@10': output.aggregates.retrieval.meanNdcgAt10.toFixed(3),
  });

  console.log('\n--- Answerability confusion matrix [expected][predicted] ---');
  const matrixRows = GROUNDING_STATUSES.map((expectedLabel, expectedIndex) => {
    const row: Record<string, string | number> = { 'expected \\ predicted': expectedLabel };
    for (let predictedIndex = 0; predictedIndex < GROUNDING_STATUSES.length; predictedIndex += 1) {
      const predictedLabel = GROUNDING_STATUSES[predictedIndex];
      if (predictedLabel === undefined) continue;
      row[predictedLabel] = output.aggregates.answerability.counts[expectedIndex]?.[predictedIndex] ?? 0;
    }
    return row;
  });
  console.table(matrixRows);
  console.log(`Answerability accuracy: ${output.aggregates.answerability.accuracy.toFixed(3)}`);
  console.log(`Citation bugs: ${output.aggregates.citationBugCount}`);
  console.log(`Errors: ${output.aggregates.errorCount}`);

  const resultsDir = resolve(import.meta.dir, 'results');
  await mkdir(resultsDir, { recursive: true });
  const timestamp = output.runAt.replace(/[:.]/g, '-');
  const resultsPath = resolve(resultsDir, `${timestamp}.json`);
  await Bun.write(resultsPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${resultsPath}`);

  await closePool(pool);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
