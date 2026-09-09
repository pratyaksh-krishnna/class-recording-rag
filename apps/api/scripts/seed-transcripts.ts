import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { SeedManifest } from '../src/ingestion/manifest';
import { seedManifest } from '../src/ingestion/seed';
import { createFileTranscriptSource } from '../src/ingestion/source';
import { upsertCohort } from '../src/db/repositories/cohorts.repo';
import { upsertModule } from '../src/db/repositories/modules.repo';
import { upsertClass } from '../src/db/repositories/classes.repo';
import { upsertTranscript } from '../src/db/repositories/transcripts.repo';
import { createPool, createDb, closePool } from '../src/db/client';
import { env } from '../src/config';
import { inngest } from '../src/inngest/client';

/**
 * CLI orchestrator for batch seeding transcripts. Loads seed.manifest.json,
 * builds real deps from database pool and file I/O, then calls seedManifest.
 *
 * Usage: bun run apps/api/scripts/seed-transcripts.ts [manifestPath] [--dry-run]
 *
 * Supports a --dry-run flag that skips event emission, so the database can
 * be seeded without a running Inngest dev server.
 */

const { values, positionals } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const manifestPath = resolve(positionals[0] ?? 'seed.manifest.json');
const isDryRun = values['dry-run'] ?? false;

// Determine the recordings root directory — parent of manifestPath or recordings/
const repoRoot = resolve(process.cwd());
const recordingsRoot = resolve(repoRoot, 'recordings');

let pool;
try {
  // Load manifest
  const manifestFile = await Bun.file(manifestPath).text();
  const manifest = JSON.parse(manifestFile) as SeedManifest;

  // Initialize database connection
  pool = createPool(env.DATABASE_URL, env.DB_POOL_MAX);
  const db = createDb(pool);

  // Build deps
  const source = createFileTranscriptSource([recordingsRoot]);

  const deps = {
    async upsertCohort(input: { slug: string; name: string }) {
      return upsertCohort(db, input);
    },
    async upsertModule(input: { cohortId: string; slug: string; name: string; position: number }) {
      return upsertModule(db, input);
    },
    async upsertClass(input: { cohortId: string; moduleId: string; slug: string; name: string; position: number }) {
      return upsertClass(db, input);
    },
    async upsertTranscript(input: {
      cohortId: string;
      moduleId: string;
      classId: string;
      format: 'srt' | 'vtt';
      sourceUri: string;
      contentHash: string;
      byteSize: number;
    }) {
      return upsertTranscript(db, input);
    },
    async readSource(sourceUri: string) {
      return source.read(sourceUri);
    },
    async emit(event: { transcriptId: string; classId: string; cohortId: string; sourceUri: string; requestedBy: string }) {
      await inngest.send({
        name: 'transcript.ingest.requested',
        data: event,
      });
    },
  };

  // Run seeding
  const summary = await seedManifest(manifest, deps, {
    requestedBy: 'bun run seed:transcripts',
    emitEvents: !isDryRun,
  });

  // Print summary
  console.log(`cohort: ${summary.cohortId}`);
  console.log(`modules: ${summary.modules}`);
  console.log(`classes: ${summary.classes}`);
  console.log(`transcripts created: ${summary.transcriptsCreated}`);
  console.log(`transcripts existing: ${summary.transcriptsExisting}`);
  console.log(`events emitted: ${summary.eventsEmitted}`);
  if (isDryRun) {
    console.log('(dry-run: events not actually sent)');
  }
} catch (error) {
  console.error('Error seeding transcripts:', error);
  process.exit(1);
} finally {
  if (pool) {
    await closePool(pool);
  }
}
