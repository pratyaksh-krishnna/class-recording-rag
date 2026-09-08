import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { runMigrations } from '../../../apps/api/migrations/run';
import { createPool, createDb, closePool, type Database } from '../../../apps/api/src/db/client';
import { assertTestDatabase } from '../../helpers/assertTestDatabase';
import { upsertCohort, findCohortById, findCohortBySlug } from '../../../apps/api/src/db/repositories/cohorts.repo';
import { upsertModule, listModulesWithClasses } from '../../../apps/api/src/db/repositories/modules.repo';
import { upsertClass, findClassById } from '../../../apps/api/src/db/repositories/classes.repo';
import {
  upsertTranscript,
  findTranscriptById,
  updateTranscriptStats,
} from '../../../apps/api/src/db/repositories/transcripts.repo';
import {
  bulkInsertChunks,
  listPendingEmbeddingChunks,
  setChunkEmbeddings,
  countChunks,
  hydrateChunksByIds,
  type ChunkInsert,
} from '../../../apps/api/src/db/repositories/chunks.repo';
import type { Pool } from 'pg';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

// vector(1536) is a fixed-dimension pgvector column — every literal must have
// exactly 1536 components or the insert/update is rejected outright.
function makeEmbedding(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => (i === 0 ? seed : 0));
}

function chunkFixture(overrides: Partial<ChunkInsert> & Pick<ChunkInsert, 'transcriptId' | 'cohortId' | 'moduleId' | 'classId' | 'chunkKey' | 'chunkIndex'>): ChunkInsert {
  return {
    text: `chunk text ${overrides.chunkIndex}`,
    startMs: overrides.chunkIndex * 1000,
    endMs: overrides.chunkIndex * 1000 + 500,
    tokenCount: 10,
    sentenceCount: 1,
    overlapSentenceCount: 0,
    chunkingVersion: 'v1',
    tokenizer: 'o200k_base',
    embeddingModel: 'text-embedding-3-small',
    embeddingDimensions: 1536,
    ...overrides,
  };
}

describeDb('db repositories', () => {
  const url = TEST_DATABASE_URL as string;
  let pool: Pool;
  let db: Database;

  let cohortId: string;
  let moduleId: string;
  let classId: string;

  beforeAll(async () => {
    assertTestDatabase(url);
    await runMigrations(url);
    pool = createPool(url);
    db = createDb(pool);
    await pool.query('TRUNCATE cohorts CASCADE');

    const cohort = await upsertCohort(db, { slug: 'repo-test-cohort', name: 'Repo Test Cohort' });
    cohortId = cohort.id;
    const mod = await upsertModule(db, { cohortId, slug: 'module-1', name: 'Module One', position: 1 });
    moduleId = mod.id;
    const klass = await upsertClass(db, { cohortId, moduleId, slug: 'class-1', name: 'Class One', position: 1 });
    classId = klass.id;
  });

  afterAll(async () => {
    await pool.query('TRUNCATE cohorts CASCADE');
    await closePool(pool);
  });

  describe('cohort/module/class upserts', () => {
    test('are idempotent: the same slug twice yields the same id and no duplicate rows', async () => {
      const cohortFirst = await upsertCohort(db, { slug: 'idempotent-cohort', name: 'Name A' });
      const cohortSecond = await upsertCohort(db, { slug: 'idempotent-cohort', name: 'Name B' });
      expect(cohortSecond.id).toBe(cohortFirst.id);
      expect(cohortSecond.name).toBe('Name B');

      const cohortCount = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM cohorts WHERE slug = $1',
        ['idempotent-cohort'],
      );
      expect(cohortCount.rows[0]?.count).toBe(1);

      const byId = await findCohortById(db, cohortFirst.id);
      expect(byId?.name).toBe('Name B');
      const bySlug = await findCohortBySlug(db, 'idempotent-cohort');
      expect(bySlug?.id).toBe(cohortFirst.id);
      expect(await findCohortBySlug(db, 'no-such-cohort-slug')).toBeNull();

      const moduleFirst = await upsertModule(db, {
        cohortId: cohortFirst.id, slug: 'mod-idem', name: 'Mod A', position: 1,
      });
      const moduleSecond = await upsertModule(db, {
        cohortId: cohortFirst.id, slug: 'mod-idem', name: 'Mod B', position: 2,
      });
      expect(moduleSecond.id).toBe(moduleFirst.id);

      const moduleCount = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM modules WHERE cohort_id = $1 AND slug = $2',
        [cohortFirst.id, 'mod-idem'],
      );
      expect(moduleCount.rows[0]?.count).toBe(1);

      const classFirst = await upsertClass(db, {
        cohortId: cohortFirst.id, moduleId: moduleFirst.id, slug: 'class-idem', name: 'Class A', position: 1,
      });
      const classSecond = await upsertClass(db, {
        cohortId: cohortFirst.id, moduleId: moduleFirst.id, slug: 'class-idem', name: 'Class B', position: 2,
      });
      expect(classSecond.id).toBe(classFirst.id);

      const classCount = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM classes WHERE module_id = $1 AND slug = $2',
        [moduleFirst.id, 'class-idem'],
      );
      expect(classCount.rows[0]?.count).toBe(1);

      const found = await findClassById(db, classFirst.id);
      expect(found?.name).toBe('Class B');
      expect(found?.position).toBe(2);

      const catalog = await listModulesWithClasses(db, cohortFirst.id);
      const catalogModule = catalog.find((m) => m.id === moduleFirst.id);
      expect(catalogModule?.classes.map((c) => c.id)).toEqual([classFirst.id]);
      expect(catalogModule?.classes[0]?.name).toBe('Class B');
    });
  });

  describe('upsertTranscript', () => {
    test('identical bytes return the existing row with created:false and the same id', async () => {
      const first = await upsertTranscript(db, {
        cohortId, moduleId, classId,
        format: 'vtt', sourceUri: 'recordings/repo-a.vtt', contentHash: 'repo-hash-1', byteSize: 100,
      });
      expect(first.created).toBe(true);

      const second = await upsertTranscript(db, {
        cohortId, moduleId, classId,
        format: 'vtt', sourceUri: 'recordings/repo-a.vtt', contentHash: 'repo-hash-1', byteSize: 100,
      });
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);

      await updateTranscriptStats(db, first.id, { cueCount: 42, durationMs: 60_000 });
      const row = await findTranscriptById(db, first.id);
      expect(row?.cueCount).toBe(42);
      expect(row?.durationMs).toBe(60_000);
    });

    test('a second DIFFERENT transcript deactivates the first without violating the one-active-per-class index', async () => {
      const first = await upsertTranscript(db, {
        cohortId, moduleId, classId,
        format: 'vtt', sourceUri: 'recordings/repo-b1.vtt', contentHash: 'repo-hash-2', byteSize: 50,
      });
      const second = await upsertTranscript(db, {
        cohortId, moduleId, classId,
        format: 'vtt', sourceUri: 'recordings/repo-b2.vtt', contentHash: 'repo-hash-3', byteSize: 60,
      });
      expect(second.created).toBe(true);
      expect(second.id).not.toBe(first.id);

      const firstRow = await findTranscriptById(db, first.id);
      const secondRow = await findTranscriptById(db, second.id);
      expect(firstRow?.isActive).toBe(false);
      expect(secondRow?.isActive).toBe(true);

      // The partial unique index itself: at most one active row per class.
      const activeCount = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM transcripts WHERE class_id = $1 AND is_active',
        [classId],
      );
      expect(activeCount.rows[0]?.count).toBe(1);
    });

    test('findTranscriptById returns null for an unknown id', async () => {
      expect(await findTranscriptById(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
    });
  });

  describe('chunks', () => {
    async function makeTranscript(contentHash: string) {
      const { id } = await upsertTranscript(db, {
        cohortId, moduleId, classId,
        format: 'vtt', sourceUri: `recordings/${contentHash}.vtt`, contentHash, byteSize: 10,
      });
      return id;
    }

    test('bulkInsertChunks is idempotent: re-inserting the same rows reports inserted:0 and adds no rows', async () => {
      const transcriptId = await makeTranscript('repo-hash-chunks-1');
      const rows: ChunkInsert[] = [0, 1, 2].map((i) =>
        chunkFixture({
          transcriptId, cohortId, moduleId, classId,
          chunkKey: `repo-test:${transcriptId}:${i}`,
          chunkIndex: i,
        }),
      );

      const first = await bulkInsertChunks(db, rows);
      expect(first.inserted).toBe(3);

      const second = await bulkInsertChunks(db, rows);
      expect(second.inserted).toBe(0);

      const rowCount = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM chunks WHERE transcript_id = $1',
        [transcriptId],
      );
      expect(rowCount.rows[0]?.count).toBe(3);
    });

    test('setChunkEmbeddings skips a chunk that already has an embedding, and countChunks reports total vs embedded', async () => {
      const transcriptId = await makeTranscript('repo-hash-chunks-2');
      const rows: ChunkInsert[] = [0, 1, 2].map((i) =>
        chunkFixture({
          transcriptId, cohortId, moduleId, classId,
          chunkKey: `repo-test:${transcriptId}:${i}`,
          chunkIndex: i,
        }),
      );
      await bulkInsertChunks(db, rows);

      const pending = await listPendingEmbeddingChunks(db, transcriptId, 10);
      expect(pending.map((p) => p.id).sort()).toEqual(
        [...(await pool.query<{ id: string }>(
          'SELECT id FROM chunks WHERE transcript_id = $1 ORDER BY chunk_index', [transcriptId],
        )).rows.map((r) => r.id)].sort(),
      );
      expect(pending).toHaveLength(3);

      const [firstPending, secondPending] = pending;
      if (!firstPending || !secondPending) throw new Error('expected at least two pending chunks');

      const firstEmbedCount = await setChunkEmbeddings(db, [{ id: firstPending.id, embedding: makeEmbedding(1) }]);
      expect(firstEmbedCount).toBe(1);

      let counts = await countChunks(db, transcriptId);
      expect(counts).toEqual({ total: 3, embedded: 1 });

      // Retry semantics: WHERE embedding IS NULL means an already-embedded
      // chunk is silently skipped, never overwritten.
      const retryCount = await setChunkEmbeddings(db, [
        { id: firstPending.id, embedding: makeEmbedding(999) },
        { id: secondPending.id, embedding: makeEmbedding(2) },
      ]);
      expect(retryCount).toBe(1); // only secondPending updates

      const firstEmbeddingRow = await pool.query<{ embedding: string }>(
        'SELECT embedding::text AS embedding FROM chunks WHERE id = $1', [firstPending.id],
      );
      expect(firstEmbeddingRow.rows[0]?.embedding?.startsWith('[1,')).toBe(true);

      counts = await countChunks(db, transcriptId);
      expect(counts).toEqual({ total: 3, embedded: 2 });
    });

    test('hydrateChunksByIds preserves requested order and omits ids from another cohort', async () => {
      const transcriptId = await makeTranscript('repo-hash-chunks-3');
      const rows: ChunkInsert[] = [0, 1, 2].map((i) =>
        chunkFixture({
          transcriptId, cohortId, moduleId, classId,
          chunkKey: `repo-test:${transcriptId}:${i}`,
          chunkIndex: i,
        }),
      );
      await bulkInsertChunks(db, rows);
      const ownRows = await pool.query<{ id: string }>(
        'SELECT id FROM chunks WHERE transcript_id = $1 ORDER BY chunk_index', [transcriptId],
      );
      const [chunkA, chunkB, chunkC] = ownRows.rows.map((r) => r.id);
      if (!chunkA || !chunkB || !chunkC) throw new Error('expected three chunk ids');

      // A chunk that belongs to a different cohort entirely.
      const otherCohort = await upsertCohort(db, { slug: 'repo-test-other-cohort', name: 'Other Cohort' });
      const otherModule = await upsertModule(db, {
        cohortId: otherCohort.id, slug: 'other-module', name: 'Other Module', position: 1,
      });
      const otherClass = await upsertClass(db, {
        cohortId: otherCohort.id, moduleId: otherModule.id, slug: 'other-class', name: 'Other Class', position: 1,
      });
      const otherTranscript = await upsertTranscript(db, {
        cohortId: otherCohort.id, moduleId: otherModule.id, classId: otherClass.id,
        format: 'vtt', sourceUri: 'recordings/other.vtt', contentHash: 'repo-hash-other', byteSize: 10,
      });
      await bulkInsertChunks(db, [
        chunkFixture({
          transcriptId: otherTranscript.id, cohortId: otherCohort.id, moduleId: otherModule.id, classId: otherClass.id,
          chunkKey: `repo-test:${otherTranscript.id}:0`,
          chunkIndex: 0,
        }),
      ]);
      const otherChunkRow = await pool.query<{ id: string }>(
        'SELECT id FROM chunks WHERE transcript_id = $1', [otherTranscript.id],
      );
      const otherChunkId = otherChunkRow.rows[0]?.id;
      if (!otherChunkId) throw new Error('expected the other cohort chunk to exist');

      // Request out of natural order and include a foreign-cohort id.
      const requested = [chunkC, chunkA, otherChunkId, chunkB];
      const hydrated = await hydrateChunksByIds(db, requested, cohortId);

      expect(hydrated.map((h) => h.id)).toEqual([chunkC, chunkA, chunkB]);
      expect(hydrated.every((h) => h.classId === classId && h.moduleId === moduleId)).toBe(true);
      expect(hydrated.every((h) => h.className === 'Class One' && h.moduleName === 'Module One')).toBe(true);
      expect(hydrated.find((h) => h.id === otherChunkId)).toBeUndefined();
    });

    test('hydrateChunksByIds returns an empty array for an empty id list', async () => {
      expect(await hydrateChunksByIds(db, [], cohortId)).toEqual([]);
    });
  });
});
