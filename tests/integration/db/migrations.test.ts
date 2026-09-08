import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { Client } from 'pg';
import { runMigrations } from '../../../apps/api/migrations/run';
import { assertTestDatabase } from '../../helpers/assertTestDatabase';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('migrations', () => {
  const url = TEST_DATABASE_URL as string;
  let client: Client;

  beforeAll(async () => {
    assertTestDatabase(url);
    client = new Client({ connectionString: url });
    await client.connect();
    // Start from a clean slate so the test is meaningful on a re-run.
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  });

  afterAll(async () => {
    await client.end();
  });

  test('applies every migration on a fresh database', async () => {
    const applied = await runMigrations(url);
    expect(applied).toContain('0001_init.sql');
  });

  test('is idempotent — a second run applies nothing', async () => {
    const applied = await runMigrations(url);
    expect(applied).toEqual([]);
  });

  test('records what it applied', async () => {
    const { rows } = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    );
    expect(rows.map((r) => r.filename)).toContain('0001_init.sql');
  });

  test('creates every expected table', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tables = rows.map((r) => r.table_name);
    for (const expected of [
      'chunks', 'classes', 'cohorts', 'conversations', 'ingestion_runs',
      'message_citations', 'messages', 'modules', 'transcripts',
    ]) {
      expect(tables).toContain(expected);
    }
  });

  test('creates the HNSW and GIN indexes on chunks', async () => {
    const { rows } = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'chunks'`,
    );
    const defs = rows.map((r) => r.indexdef).join('\n');
    expect(defs).toContain('USING hnsw');
    expect(defs).toContain('vector_cosine_ops');
    expect(defs).toContain('USING gin');
  });

  test('chunks.tsv is a stored generated column', async () => {
    const { rows } = await client.query<{ is_generated: string }>(
      `SELECT is_generated FROM information_schema.columns
       WHERE table_name = 'chunks' AND column_name = 'tsv'`,
    );
    expect(rows[0]?.is_generated).toBe('ALWAYS');
  });
});
