import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { runMigrations } from '../../../apps/api/migrations/run';
import { createPool, closePool } from '../../../apps/api/src/db/client';
import { createApp } from '../../../apps/api/src/app';
import { withTestServer } from '../../helpers/testServer';
import type { Pool } from 'pg';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('health routes', () => {
  const url = TEST_DATABASE_URL as string;
  let pool: Pool;

  beforeAll(async () => {
    await runMigrations(url);
    pool = createPool(url);
  });

  afterAll(async () => {
    await closePool(pool);
  });

  test('GET /health reports liveness without touching the database', async () => {
    const app = createApp({ pool });
    await withTestServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    });
  });

  test('GET /ready confirms the database and the vector extension', async () => {
    const app = createApp({ pool });
    await withTestServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ready`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ready', database: true, pgvector: true });
    });
  });

  test('echoes a request id on every response', async () => {
    const app = createApp({ pool });
    await withTestServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`, {
        headers: { 'x-request-id': 'trace-me' },
      });
      expect(res.headers.get('x-request-id')).toBe('trace-me');
    });
  });

  test('generates a request id when the caller supplies none', async () => {
    const app = createApp({ pool });
    await withTestServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.headers.get('x-request-id')).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  test('returns a structured error body for an unknown route', async () => {
    const app = createApp({ pool });
    await withTestServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/nope`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; requestId: string } };
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.requestId).toBeString();
      expect(JSON.stringify(body)).not.toContain('stack');
    });
  });

  test('GET /ready fails closed when the database is unreachable', async () => {
    const brokenPool = createPool('postgres://rag:wrong@localhost:5432/rag');
    const app = createApp({ pool: brokenPool });
    await withTestServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ready`);
      expect(res.status).toBe(503);
    });
    await closePool(brokenPool).catch(() => undefined);
  });
});
