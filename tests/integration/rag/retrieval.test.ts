import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import type { Pool } from 'pg';
import { runMigrations } from '../../../apps/api/migrations/run';
import { createPool, createDb, closePool, type Database } from '../../../apps/api/src/db/client';
import { assertTestDatabase } from '../../helpers/assertTestDatabase';
import { upsertCohort } from '../../../apps/api/src/db/repositories/cohorts.repo';
import { upsertModule } from '../../../apps/api/src/db/repositories/modules.repo';
import { upsertClass } from '../../../apps/api/src/db/repositories/classes.repo';
import { upsertTranscript } from '../../../apps/api/src/db/repositories/transcripts.repo';
import { bulkInsertChunks, setChunkEmbeddings, type ChunkInsert } from '../../../apps/api/src/db/repositories/chunks.repo';
import { retrieveByVector } from '../../../apps/api/src/rag/retrieval/vector.retriever';
import { retrieveByKeyword } from '../../../apps/api/src/rag/retrieval/keyword.retriever';
import { retrieveHybrid, type PlannedQuery } from '../../../apps/api/src/rag/retrieval/hybrid';
import { createDeterministicEmbeddingProvider } from '../../../apps/api/src/providers/embedding/deterministic.mock';
import type { EmbeddingProvider } from '../../../apps/api/src/providers/embedding/provider';
import { isAppError } from '../../../apps/api/src/errors/AppError';
import type { RagConfig } from '../../../apps/api/src/config/rag';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const CHUNKING_VERSION = 'v1';
const EMBEDDING_MODEL = 'deterministic-mock';
const provider = createDeterministicEmbeddingProvider({ model: EMBEDDING_MODEL, dimensions: 1536 });

function testRagConfig(): RagConfig {
  return {
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
    features: { allowGeneralKnowledgeFallback: true, diagnosticsEnabled: false },
  };
}

function chunkFixture(
  overrides: Partial<ChunkInsert> & Pick<ChunkInsert, 'transcriptId' | 'cohortId' | 'moduleId' | 'classId' | 'chunkKey' | 'chunkIndex' | 'text'>,
): ChunkInsert {
  return {
    startMs: overrides.chunkIndex * 1000,
    endMs: overrides.chunkIndex * 1000 + 500,
    tokenCount: 10,
    sentenceCount: 1,
    overlapSentenceCount: 0,
    chunkingVersion: CHUNKING_VERSION,
    tokenizer: 'o200k_base',
    embeddingModel: EMBEDDING_MODEL,
    embeddingDimensions: 1536,
    ...overrides,
  };
}

/**
 * db.transaction and db.execute are prototype methods; Object.create keeps
 * the prototype chain (so untouched methods still work against the real
 * connection pool) while an own property on the child shadows just the one
 * method we want to fail — this is how the "one retriever fails" and
 * "every retriever fails" cases are injected without touching real infra.
 * retrieveByVector calls db.transaction(); retrieveByKeyword calls
 * db.execute() directly, so breaking each independently isolates one
 * retriever at a time.
 */
function withBrokenMethods(base: Database, methods: Array<'transaction' | 'execute'>): Database {
  const broken = Object.create(base) as Record<string, unknown>;
  for (const method of methods) {
    broken[method] = async () => {
      throw new Error(`simulated ${method} failure`);
    };
  }
  return broken as unknown as Database;
}

describeDb('hybrid retrieval', () => {
  const url = TEST_DATABASE_URL as string;
  let pool: Pool;
  let db: Database;

  let cohortAId: string;
  let moduleAId: string;
  let classAId: string;
  let transcriptAId: string;

  let cohortBId: string;
  let moduleBId: string;
  let classBId: string;
  let transcriptBId: string;

  // Cohort A chunk ids, keyed by role, filled in beforeAll.
  const ids: Record<string, string> = {};

  async function embedAndSet(id: string, text: string) {
    const [embedding] = await provider.embed([text]);
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

    const cohortA = await upsertCohort(db, { slug: 'retrieval-cohort-a', name: 'Retrieval Cohort A' });
    cohortAId = cohortA.id;
    const moduleA = await upsertModule(db, { cohortId: cohortAId, slug: 'module-a', name: 'Module A', position: 1 });
    moduleAId = moduleA.id;
    const classA = await upsertClass(db, { cohortId: cohortAId, moduleId: moduleAId, slug: 'class-a', name: 'Class A', position: 1 });
    classAId = classA.id;
    const transcriptA = await upsertTranscript(db, {
      cohortId: cohortAId, moduleId: moduleAId, classId: classAId,
      format: 'vtt', sourceUri: 'recordings/retrieval-a.vtt', contentHash: 'retrieval-hash-a', byteSize: 10,
    });
    transcriptAId = transcriptA.id;

    const cohortB = await upsertCohort(db, { slug: 'retrieval-cohort-b', name: 'Retrieval Cohort B' });
    cohortBId = cohortB.id;
    const moduleB = await upsertModule(db, { cohortId: cohortBId, slug: 'module-b', name: 'Module B', position: 1 });
    moduleBId = moduleB.id;
    const classB = await upsertClass(db, { cohortId: cohortBId, moduleId: moduleBId, slug: 'class-b', name: 'Class B', position: 1 });
    classBId = classB.id;
    const transcriptB = await upsertTranscript(db, {
      cohortId: cohortBId, moduleId: moduleBId, classId: classBId,
      format: 'vtt', sourceUri: 'recordings/retrieval-b.vtt', contentHash: 'retrieval-hash-b', byteSize: 10,
    });
    transcriptBId = transcriptB.id;

    const gyroText = 'The gyroscope sensor measures angular velocity of the device.';
    const accelText = 'The accelerometer measures linear acceleration forces.';
    const heavyPostgresText = 'postgres postgres postgres indexing is fast.';
    const lightPostgresText = 'postgres indexing is fast.';
    const orphanText = 'orphan chunk with unique word zylophant that never gets embedded.';
    const wrongVersionText = 'wrong chunking version chunk about gyroscope calibration.';
    const wrongModelText = 'wrong embedding model chunk about gyroscope calibration.';

    const rows: ChunkInsert[] = [
      chunkFixture({ transcriptId: transcriptAId, cohortId: cohortAId, moduleId: moduleAId, classId: classAId, chunkKey: 'retrieval-a:gyro', chunkIndex: 0, text: gyroText }),
      chunkFixture({ transcriptId: transcriptAId, cohortId: cohortAId, moduleId: moduleAId, classId: classAId, chunkKey: 'retrieval-a:accel', chunkIndex: 1, text: accelText }),
      chunkFixture({ transcriptId: transcriptAId, cohortId: cohortAId, moduleId: moduleAId, classId: classAId, chunkKey: 'retrieval-a:pg-heavy', chunkIndex: 2, text: heavyPostgresText }),
      chunkFixture({ transcriptId: transcriptAId, cohortId: cohortAId, moduleId: moduleAId, classId: classAId, chunkKey: 'retrieval-a:pg-light', chunkIndex: 3, text: lightPostgresText }),
      chunkFixture({ transcriptId: transcriptAId, cohortId: cohortAId, moduleId: moduleAId, classId: classAId, chunkKey: 'retrieval-a:orphan', chunkIndex: 4, text: orphanText }),
      chunkFixture({ transcriptId: transcriptAId, cohortId: cohortAId, moduleId: moduleAId, classId: classAId, chunkKey: 'retrieval-a:wrong-version', chunkIndex: 5, text: wrongVersionText, chunkingVersion: 'v2' }),
      chunkFixture({ transcriptId: transcriptAId, cohortId: cohortAId, moduleId: moduleAId, classId: classAId, chunkKey: 'retrieval-a:wrong-model', chunkIndex: 6, text: wrongModelText, embeddingModel: 'other-model' }),
      // Cohort B: same texts as cohort A's gyro/heavy-postgres chunks, so an
      // unfiltered query would tie or rank these alongside cohort A's rows.
      chunkFixture({ transcriptId: transcriptBId, cohortId: cohortBId, moduleId: moduleBId, classId: classBId, chunkKey: 'retrieval-b:gyro', chunkIndex: 0, text: gyroText }),
      chunkFixture({ transcriptId: transcriptBId, cohortId: cohortBId, moduleId: moduleBId, classId: classBId, chunkKey: 'retrieval-b:pg-heavy', chunkIndex: 1, text: heavyPostgresText }),
    ];
    await bulkInsertChunks(db, rows);

    const byKey = await pool.query<{ id: string; chunk_key: string }>(
      "SELECT id, chunk_key FROM chunks WHERE chunk_key LIKE 'retrieval-%'",
    );
    const idByKey = new Map(byKey.rows.map((r) => [r.chunk_key, r.id]));
    for (const [key, id] of idByKey) ids[key] = id;

    // Embed everything except the deliberately-orphaned chunk.
    await embedAndSet(ids['retrieval-a:gyro']!, gyroText);
    await embedAndSet(ids['retrieval-a:accel']!, accelText);
    await embedAndSet(ids['retrieval-a:pg-heavy']!, heavyPostgresText);
    await embedAndSet(ids['retrieval-a:pg-light']!, lightPostgresText);
    await embedAndSet(ids['retrieval-a:wrong-version']!, wrongVersionText);
    await embedAndSet(ids['retrieval-a:wrong-model']!, wrongModelText);
    await embedAndSet(ids['retrieval-b:gyro']!, gyroText);
    await embedAndSet(ids['retrieval-b:pg-heavy']!, heavyPostgresText);
  });

  afterAll(async () => {
    await pool.query('TRUNCATE cohorts CASCADE');
    await closePool(pool);
  });

  describe('retrieveByVector', () => {
    test('returns nearest neighbours in order: a chunk embedded with its own text ranks first', async () => {
      const [embedding] = await provider.embed(['The gyroscope sensor measures angular velocity of the device.']);
      const results = await retrieveByVector(db, {
        cohortId: cohortAId,
        embedding: embedding!,
        limit: 5,
        chunkingVersion: CHUNKING_VERSION,
        embeddingModel: EMBEDDING_MODEL,
        efSearch: 40,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.id).toBe(ids['retrieval-a:gyro']);
      expect(results[0]?.score).toBeGreaterThan(0.999999);
    });

    test('never returns a row whose embedding is NULL', async () => {
      const [embedding] = await provider.embed(['orphan chunk with unique word zylophant that never gets embedded.']);
      const results = await retrieveByVector(db, {
        cohortId: cohortAId,
        embedding: embedding!,
        limit: 10,
        chunkingVersion: CHUNKING_VERSION,
        embeddingModel: EMBEDDING_MODEL,
        efSearch: 40,
      });
      expect(results.find((r) => r.id === ids['retrieval-a:orphan'])).toBeUndefined();
    });

    test('never returns a chunk written under a different chunking_version or embedding_model', async () => {
      const [wrongVersionEmbedding] = await provider.embed(['wrong chunking version chunk about gyroscope calibration.']);
      const wrongVersionResults = await retrieveByVector(db, {
        cohortId: cohortAId,
        embedding: wrongVersionEmbedding!,
        limit: 10,
        chunkingVersion: CHUNKING_VERSION,
        embeddingModel: EMBEDDING_MODEL,
        efSearch: 40,
      });
      expect(wrongVersionResults.find((r) => r.id === ids['retrieval-a:wrong-version'])).toBeUndefined();

      const [wrongModelEmbedding] = await provider.embed(['wrong embedding model chunk about gyroscope calibration.']);
      const wrongModelResults = await retrieveByVector(db, {
        cohortId: cohortAId,
        embedding: wrongModelEmbedding!,
        limit: 10,
        chunkingVersion: CHUNKING_VERSION,
        embeddingModel: EMBEDDING_MODEL,
        efSearch: 40,
      });
      expect(wrongModelResults.find((r) => r.id === ids['retrieval-a:wrong-model'])).toBeUndefined();
    });

    test('COHORT ISOLATION: a cohort B chunk with an identical (and thus identically-scored) vector is never returned for cohort A', async () => {
      const [embedding] = await provider.embed(['The gyroscope sensor measures angular velocity of the device.']);
      const results = await retrieveByVector(db, {
        cohortId: cohortAId,
        embedding: embedding!,
        limit: 10,
        chunkingVersion: CHUNKING_VERSION,
        embeddingModel: EMBEDDING_MODEL,
        efSearch: 40,
      });
      expect(results.find((r) => r.id === ids['retrieval-b:gyro'])).toBeUndefined();
      expect(results.every((r) => r.classId === classAId)).toBe(true);

      // And the reverse: cohort B's own query never sees cohort A's rows.
      const resultsB = await retrieveByVector(db, {
        cohortId: cohortBId,
        embedding: embedding!,
        limit: 10,
        chunkingVersion: CHUNKING_VERSION,
        embeddingModel: EMBEDDING_MODEL,
        efSearch: 40,
      });
      expect(resultsB.find((r) => r.id === ids['retrieval-a:gyro'])).toBeUndefined();
      expect(resultsB[0]?.id).toBe(ids['retrieval-b:gyro']);
    });
  });

  describe('retrieveByKeyword', () => {
    test('ranks by ts_rank_cd: the chunk with more occurrences of the query term ranks first', async () => {
      const results = await retrieveByKeyword(db, {
        cohortId: cohortAId,
        query: 'postgres',
        limit: 10,
        chunkingVersion: CHUNKING_VERSION,
        embeddingModel: EMBEDDING_MODEL,
        ftsLanguage: 'english',
      });

      expect(results.map((r) => r.id)).toContain(ids['retrieval-a:pg-heavy']!);
      expect(results.map((r) => r.id)).toContain(ids['retrieval-a:pg-light']!);
      const heavyIndex = results.findIndex((r) => r.id === ids['retrieval-a:pg-heavy']);
      const lightIndex = results.findIndex((r) => r.id === ids['retrieval-a:pg-light']);
      expect(heavyIndex).toBeGreaterThanOrEqual(0);
      expect(lightIndex).toBeGreaterThan(heavyIndex);
      expect(results[0]?.score).toBeGreaterThanOrEqual(results[1]?.score ?? 0);
    });

    test('adversarial input does not raise and simply returns few/no rows', async () => {
      const results = await retrieveByKeyword(db, {
        cohortId: cohortAId,
        query: 'a & b | ( ',
        limit: 10,
        chunkingVersion: CHUNKING_VERSION,
        embeddingModel: EMBEDDING_MODEL,
        ftsLanguage: 'english',
      });
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    test('never returns a row whose embedding is NULL', async () => {
      const results = await retrieveByKeyword(db, {
        cohortId: cohortAId,
        query: 'zylophant',
        limit: 10,
        chunkingVersion: CHUNKING_VERSION,
        embeddingModel: EMBEDDING_MODEL,
        ftsLanguage: 'english',
      });
      expect(results.find((r) => r.id === ids['retrieval-a:orphan'])).toBeUndefined();
    });

    test('never returns a chunk written under a different chunking_version or embedding_model', async () => {
      const results = await retrieveByKeyword(db, {
        cohortId: cohortAId,
        query: 'calibration',
        limit: 10,
        chunkingVersion: CHUNKING_VERSION,
        embeddingModel: EMBEDDING_MODEL,
        ftsLanguage: 'english',
      });
      expect(results.find((r) => r.id === ids['retrieval-a:wrong-version'])).toBeUndefined();
      expect(results.find((r) => r.id === ids['retrieval-a:wrong-model'])).toBeUndefined();
    });

    test('COHORT ISOLATION: a cohort B chunk that matches the same keyword is never returned for cohort A', async () => {
      const results = await retrieveByKeyword(db, {
        cohortId: cohortAId,
        query: 'postgres',
        limit: 10,
        chunkingVersion: CHUNKING_VERSION,
        embeddingModel: EMBEDDING_MODEL,
        ftsLanguage: 'english',
      });
      expect(results.find((r) => r.id === ids['retrieval-b:pg-heavy'])).toBeUndefined();
      expect(results.every((r) => r.classId === classAId)).toBe(true);

      const resultsB = await retrieveByKeyword(db, {
        cohortId: cohortBId,
        query: 'postgres',
        limit: 10,
        chunkingVersion: CHUNKING_VERSION,
        embeddingModel: EMBEDDING_MODEL,
        ftsLanguage: 'english',
      });
      expect(resultsB.find((r) => r.id === ids['retrieval-a:pg-heavy'])).toBeUndefined();
      expect(resultsB.find((r) => r.id === ids['retrieval-a:pg-light'])).toBeUndefined();
      expect(resultsB[0]?.id).toBe(ids['retrieval-b:pg-heavy']);
    });
  });

  describe('retrieveHybrid', () => {
    function countingProvider(): { provider: EmbeddingProvider; callCount: () => number } {
      let calls = 0;
      return {
        provider: {
          model: provider.model,
          dimensions: provider.dimensions,
          async embed(texts) {
            calls += 1;
            return provider.embed(texts);
          },
        },
        callCount: () => calls,
      };
    }

    test('issues exactly one embed call for N queries and produces 2N lists', async () => {
      const { provider: counted, callCount } = countingProvider();
      const queries: PlannedQuery[] = [
        { label: 'contextualized', text: 'gyroscope sensor angular velocity' },
        { label: 'rewrite', text: 'postgres indexing performance' },
        { label: 'sub_query_1', text: 'accelerometer linear acceleration' },
      ];

      const result = await retrieveHybrid(
        { db, embeddings: counted, config: testRagConfig() },
        { cohortId: cohortAId, queries },
      );

      expect(callCount()).toBe(1);
      expect(result.lists).toHaveLength(6);
      expect(result.diagnostics).toHaveLength(6);
      const listIds = result.lists.map((l) => l.id).sort();
      expect(listIds).toEqual(['q0:keyword', 'q0:vector', 'q1:keyword', 'q1:vector', 'q2:keyword', 'q2:vector'].sort());
      for (const list of result.lists) {
        expect(['vector', 'keyword']).toContain(list.retriever);
        expect(Array.isArray(list.chunkIds)).toBe(true);
      }
      for (const diag of result.diagnostics) {
        expect(diag.latencyMs).toBeGreaterThanOrEqual(0);
        expect(diag.count).toBe(result.lists.find((l) => l.id === diag.listId)?.chunkIds.length ?? -1);
      }
    });

    test('tolerates one retriever failing and still returns the other retriever’s list', async () => {
      const brokenDb = withBrokenMethods(db, ['transaction']); // breaks retrieveByVector only
      const queries: PlannedQuery[] = [{ label: 'contextualized', text: 'postgres indexing performance' }];

      const result = await retrieveHybrid(
        { db: brokenDb, embeddings: provider, config: testRagConfig() },
        { cohortId: cohortAId, queries },
      );

      expect(result.lists).toHaveLength(1);
      expect(result.lists[0]?.id).toBe('q0:keyword');
      expect(result.diagnostics).toHaveLength(1);
    });

    test('throws RETRIEVAL_FAILED when every retriever fails', async () => {
      const brokenDb = withBrokenMethods(db, ['transaction', 'execute']);
      const queries: PlannedQuery[] = [{ label: 'contextualized', text: 'postgres indexing performance' }];

      let caught: unknown;
      try {
        await retrieveHybrid({ db: brokenDb, embeddings: provider, config: testRagConfig() }, { cohortId: cohortAId, queries });
      } catch (err) {
        caught = err;
      }
      expect(isAppError(caught)).toBe(true);
      expect((caught as { code?: string }).code).toBe('RETRIEVAL_FAILED');
    });
  });
});
