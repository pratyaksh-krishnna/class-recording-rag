import { test, expect, describe, afterAll } from 'bun:test';
import { Client } from 'pg';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('postgres container', () => {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  let connected = false;

  afterAll(async () => {
    if (connected) await client.end();
  });

  test('accepts connections', async () => {
    await client.connect();
    connected = true;
    const { rows } = await client.query<{ one: number }>('SELECT 1 AS one');
    expect(rows[0]?.one).toBe(1);
  });

  test('can create the vector extension', async () => {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    const { rows } = await client.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    expect(rows[0]?.extname).toBe('vector');
  });

  test('supports cosine distance on a vector literal', async () => {
    const { rows } = await client.query<{ distance: number }>(
      "SELECT '[1,0,0]'::vector <=> '[1,0,0]'::vector AS distance",
    );
    expect(Number(rows[0]?.distance)).toBeCloseTo(0, 6);
  });
});
