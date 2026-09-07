import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Applies every .sql file in `dir` that has not been applied yet, in filename
 * order, each inside its own transaction. Returns the filenames applied by
 * THIS call, so an already-migrated database returns an empty array.
 *
 * Filename order is why migrations are numbered: 0001, 0002, ... Sorting is
 * lexicographic, so zero-padding is required.
 */
export async function runMigrations(
  connectionString: string,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const entries = await readdir(dir);
    const files = entries.filter((f) => f.endsWith('.sql')).sort();

    const { rows } = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations',
    );
    const already = new Set(rows.map((r) => r.filename));

    const applied: string[] = [];
    for (const file of files) {
      if (already.has(file)) continue;

      const sql = await readFile(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${file} failed: ${message}`, { cause: error });
      }
    }

    return applied;
  } finally {
    await client.end();
  }
}

// CLI entry point: `bun run migrate`
if (import.meta.main) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
    process.exit(1);
  }

  const applied = await runMigrations(connectionString);
  if (applied.length === 0) {
    console.log('Database is already up to date.');
  } else {
    for (const file of applied) console.log(`Applied ${file}`);
  }
}
