import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { runMigrations } from '../../../apps/api/migrations/run';
import { createPool, createDb, closePool, type Database } from '../../../apps/api/src/db/client';
import { createApp } from '../../../apps/api/src/app';
import { withTestServer } from '../../helpers/testServer';
import { assertTestDatabase } from '../../helpers/assertTestDatabase';
import { upsertCohort } from '../../../apps/api/src/db/repositories/cohorts.repo';
import { upsertModule } from '../../../apps/api/src/db/repositories/modules.repo';
import { upsertClass } from '../../../apps/api/src/db/repositories/classes.repo';
import { findTranscriptById, upsertTranscript } from '../../../apps/api/src/db/repositories/transcripts.repo';
import { findRunById } from '../../../apps/api/src/db/repositories/ingestionRuns.repo';
import type { InngestEventSender } from '../../../apps/api/src/http/routes/transcripts.routes';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const SRT_CONTENT = `1
00:00:00,000 --> 00:00:02,000
Hello and welcome to the class.

2
00:00:02,000 --> 00:00:04,000
Today we will cover retrieval augmented generation.
`;

/** Records every event handed to `.send` instead of talking to a dev server. */
function createInngestStub(): { client: InngestEventSender; calls: Array<{ name: string; data: unknown }> } {
  const calls: Array<{ name: string; data: unknown }> = [];
  return {
    calls,
    client: {
      send: async (event) => {
        calls.push(event);
        return { ids: ['stub-event-id'] };
      },
    },
  };
}

function transcriptForm(fields: Record<string, string>, file?: { name: string; content: string; type: string }): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  if (file) form.append('file', new Blob([file.content], { type: file.type }), file.name);
  return form;
}

describeDb('transcripts routes', () => {
  const url = TEST_DATABASE_URL as string;
  let pool: Pool;
  let db: Database;
  let uploadsDir: string;

  let cohortId: string;
  let moduleId: string;
  let classId: string;

  beforeAll(async () => {
    assertTestDatabase(url);
    await runMigrations(url);
    pool = createPool(url);
    db = createDb(pool);
    uploadsDir = await mkdtemp(join(tmpdir(), 'transcripts-test-'));

    const cohort = await upsertCohort(db, { slug: 'transcripts-test-cohort', name: 'Transcripts Test Cohort' });
    cohortId = cohort.id;
    const mod = await upsertModule(db, { cohortId, slug: 'module-1', name: 'Module One', position: 1 });
    moduleId = mod.id;
    const klass = await upsertClass(db, {
      cohortId,
      moduleId,
      slug: 'class-1',
      name: 'Class One',
      position: 1,
    });
    classId = klass.id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cohorts WHERE id = $1', [cohortId]);
    await closePool(pool);
    await rm(uploadsDir, { recursive: true, force: true });
  });

  function buildApp(inngest: InngestEventSender) {
    return createApp({
      pool,
      db,
      inngest,
      uploadsDir,
      transcriptsConfig: { maxUploadBytes: 5_242_880, chunkingVersion: 'v1', embeddingModel: 'text-embedding-3-small' },
    });
  }

  test('rejects a .txt upload as UNSUPPORTED_FILE_TYPE', async () => {
    const { client } = createInngestStub();
    const app = buildApp(client);
    await withTestServer(app, async (baseUrl) => {
      const form = transcriptForm({ classId }, { name: 'notes.txt', content: 'plain text', type: 'text/plain' });
      const res = await fetch(`${baseUrl}/api/transcripts`, { method: 'POST', body: form });
      expect(res.status).toBe(415);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
      expect(JSON.stringify(body)).not.toContain('stack');
    });
  });

  test('accepts a valid .srt upload: 202, rows created, one Inngest event recorded', async () => {
    const { client, calls } = createInngestStub();
    const app = buildApp(client);
    await withTestServer(app, async (baseUrl) => {
      const form = transcriptForm({ classId }, { name: 'lecture.srt', content: SRT_CONTENT, type: 'text/plain' });
      const res = await fetch(`${baseUrl}/api/transcripts`, { method: 'POST', body: form });
      expect(res.status).toBe(202);

      const body = (await res.json()) as { transcriptId: string; ingestionRunId: string; status: string };
      expect(body.transcriptId).toBeString();
      expect(body.ingestionRunId).toBeString();
      expect(body.status).toBe('pending');

      const transcript = await findTranscriptById(db, body.transcriptId);
      expect(transcript).not.toBeNull();
      expect(transcript?.classId).toBe(classId);
      expect(transcript?.format).toBe('srt');

      const run = await findRunById(db, body.ingestionRunId);
      expect(run).not.toBeNull();
      expect(run?.transcriptId).toBe(body.transcriptId);
      expect(run?.status).toBe('pending');

      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe('transcript.ingest.requested');
      expect((calls[0]?.data as { transcriptId: string }).transcriptId).toBe(body.transcriptId);
    });
  });

  test('uploading the same bytes twice does not create a second transcript', async () => {
    const { client } = createInngestStub();
    const app = buildApp(client);
    await withTestServer(app, async (baseUrl) => {
      const content = SRT_CONTENT + '\n3\n00:00:04,000 --> 00:00:06,000\nRepeat upload fixture.\n';
      const form = () => transcriptForm({ classId }, { name: 'lecture-2.srt', content, type: 'text/plain' });

      const first = await fetch(`${baseUrl}/api/transcripts`, { method: 'POST', body: form() });
      expect(first.status).toBe(202);
      const firstBody = (await first.json()) as { transcriptId: string };

      const before = await pool.query('SELECT count(*)::int AS n FROM transcripts WHERE class_id = $1', [classId]);

      const second = await fetch(`${baseUrl}/api/transcripts`, { method: 'POST', body: form() });
      expect(second.status).toBe(202);
      const secondBody = (await second.json()) as { transcriptId: string };

      expect(secondBody.transcriptId).toBe(firstBody.transcriptId);

      const after = await pool.query('SELECT count(*)::int AS n FROM transcripts WHERE class_id = $1', [classId]);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });
  });

  test('rejects a missing classId as VALIDATION_ERROR', async () => {
    const { client } = createInngestStub();
    const app = buildApp(client);
    await withTestServer(app, async (baseUrl) => {
      const form = transcriptForm({}, { name: 'lecture.srt', content: SRT_CONTENT, type: 'text/plain' });
      const res = await fetch(`${baseUrl}/api/transcripts`, { method: 'POST', body: form });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(body)).not.toContain('stack');
    });
  });

  test('rejects an unknown classId with 404', async () => {
    const { client } = createInngestStub();
    const app = buildApp(client);
    await withTestServer(app, async (baseUrl) => {
      const form = transcriptForm(
        { classId: '00000000-0000-0000-0000-000000000000' },
        { name: 'lecture.srt', content: SRT_CONTENT, type: 'text/plain' },
      );
      const res = await fetch(`${baseUrl}/api/transcripts`, { method: 'POST', body: form });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  test('GET /api/transcripts/:id (keyed by transcript id) returns ingestion status and chunk counts', async () => {
    const { client } = createInngestStub();
    const app = buildApp(client);
    await withTestServer(app, async (baseUrl) => {
      const content = SRT_CONTENT + '\n4\n00:00:06,000 --> 00:00:08,000\nGET route fixture.\n';
      const uploadForm = transcriptForm({ classId }, { name: 'lecture-3.srt', content, type: 'text/plain' });
      const uploadRes = await fetch(`${baseUrl}/api/transcripts`, { method: 'POST', body: uploadForm });
      expect(uploadRes.status).toBe(202);
      const { transcriptId, ingestionRunId } = (await uploadRes.json()) as {
        transcriptId: string;
        ingestionRunId: string;
      };

      const res = await fetch(`${baseUrl}/api/transcripts/${transcriptId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        transcriptId: string;
        ingestionRunId: string;
        status: string;
        chunkCount: { total: number; embedded: number };
      };
      expect(body.transcriptId).toBe(transcriptId);
      // The latest run for this transcript — the one just created by POST.
      expect(body.ingestionRunId).toBe(ingestionRunId);
      expect(body.status).toBe('pending');
      expect(body.chunkCount).toEqual({ total: 0, embedded: 0 });
    });
  });

  test('GET /api/transcripts/:id returns 200 with no run info when the transcript has no run yet', async () => {
    const { client } = createInngestStub();
    const app = buildApp(client);
    await withTestServer(app, async (baseUrl) => {
      const hasher = new Bun.CryptoHasher('sha256');
      hasher.update('no-run-yet-fixture');
      const contentHash = hasher.digest('hex');

      // Bypasses POST /api/transcripts entirely — a transcript row can exist
      // with no ingestion_runs row yet (e.g. seeded directly), which is the
      // case this route must still answer with 200, not 404.
      const transcript = await upsertTranscript(db, {
        cohortId,
        moduleId,
        classId,
        format: 'srt',
        sourceUri: join(uploadsDir, cohortId, `${contentHash}.srt`),
        contentHash,
        byteSize: 42,
      });

      const res = await fetch(`${baseUrl}/api/transcripts/${transcript.id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        transcriptId: string;
        ingestionRunId: string | null;
        status: string;
        chunkCount: { total: number; embedded: number };
      };
      expect(body.transcriptId).toBe(transcript.id);
      expect(body.ingestionRunId).toBeNull();
      expect(body.status).toBe('pending');
      expect(body.chunkCount).toEqual({ total: 0, embedded: 0 });
    });
  });

  test('GET /api/transcripts/:id returns 404 for an unknown transcript id', async () => {
    const { client } = createInngestStub();
    const app = buildApp(client);
    await withTestServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/transcripts/00000000-0000-0000-0000-000000000000`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
      expect(JSON.stringify(body)).not.toContain('stack');
    });
  });
});
