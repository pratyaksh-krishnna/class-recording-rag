import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { runMigrations } from '../../../apps/api/migrations/run';
import { createPool, createDb, closePool } from '../../../apps/api/src/db/client';
import { cohorts, modules, classes } from '../../../apps/api/src/db/schema';
import { assertTestDatabase } from '../../helpers/assertTestDatabase';
import type { Pool } from 'pg';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('drizzle schema', () => {
  const url = TEST_DATABASE_URL as string;
  let pool: Pool;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    assertTestDatabase(url);
    await runMigrations(url);
    pool = createPool(url);
    db = createDb(pool);
    await pool.query('TRUNCATE cohorts CASCADE');
  });

  afterAll(async () => {
    await pool.query('TRUNCATE cohorts CASCADE');
    await closePool(pool);
  });

  test('inserts and reads the hierarchy', async () => {
    const [cohort] = await db
      .insert(cohorts)
      .values({ slug: 'mobile-dev-cohort', name: 'mobile dev cohort' })
      .returning();
    expect(cohort?.id).toBeString();

    const [module] = await db
      .insert(modules)
      .values({ cohortId: cohort!.id, slug: 'module-7', name: 'Device Sensors', position: 7 })
      .returning();

    const [klass] = await db
      .insert(classes)
      .values({
        cohortId: cohort!.id,
        moduleId: module!.id,
        slug: 'understanding-the-gyroscope',
        name: '2. Understanding the Gyroscope',
        position: 2,
      })
      .returning();

    const found = await db.select().from(classes).where(eq(classes.id, klass!.id));
    expect(found[0]?.name).toBe('2. Understanding the Gyroscope');
    expect(found[0]?.recordingUrl).toBeNull();
  });

  test('rejects a class whose cohort disagrees with its module', async () => {
    // This is the structural cross-cohort guarantee from spec §3.2:
    // the composite FK makes the mismatch impossible, not merely unlikely.
    const [otherCohort] = await db
      .insert(cohorts)
      .values({ slug: 'other-cohort', name: 'other cohort' })
      .returning();
    const [module] = await db
      .select()
      .from(modules)
      .where(eq(modules.slug, 'module-7'));

    // Wrapped in an async IIFE: a Drizzle query builder is a thenable, and
    // expect().rejects needs a genuine Promise.
    await expect(
      (async () => {
        await db.insert(classes).values({
          cohortId: otherCohort!.id, // belongs to a different cohort
          moduleId: module!.id,
          slug: 'smuggled-class',
          name: 'Smuggled Class',
          position: 99,
        });
      })(),
    ).rejects.toThrow();
  });

  test('rejects a second active transcript for the same class', async () => {
    const [klass] = await db
      .select()
      .from(classes)
      .where(eq(classes.slug, 'understanding-the-gyroscope'));

    const base = {
      cohortId: klass!.cohortId,
      moduleId: klass!.moduleId,
      classId: klass!.id,
      format: 'vtt' as const,
      sourceUri: 'recordings/a.vtt',
      byteSize: 100,
    };

    await pool.query(
      `INSERT INTO transcripts (cohort_id, module_id, class_id, format, source_uri, content_hash, byte_size)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [base.cohortId, base.moduleId, base.classId, base.format, base.sourceUri, 'hash-a', base.byteSize],
    );

    await expect(
      (async () => {
        await pool.query(
          `INSERT INTO transcripts (cohort_id, module_id, class_id, format, source_uri, content_hash, byte_size)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [base.cohortId, base.moduleId, base.classId, base.format, 'recordings/b.vtt', 'hash-b', base.byteSize],
        );
      })(),
    ).rejects.toThrow();
  });

  test('rejects a duplicate transcript with identical content hash', async () => {
    const [klass] = await db
      .select()
      .from(classes)
      .where(eq(classes.slug, 'understanding-the-gyroscope'));

    await expect(
      (async () => {
        await pool.query(
          `INSERT INTO transcripts (cohort_id, module_id, class_id, format, source_uri, content_hash, byte_size, is_active)
           VALUES ($1,$2,$3,'vtt','recordings/a.vtt','hash-a',100,false)`,
          [klass!.cohortId, klass!.moduleId, klass!.id],
        );
      })(),
    ).rejects.toThrow();
  });

  test('rejects a chunk whose transcript_id points at a different cohort', async () => {
    // Create a second cohort and module for the chunk
    const [cohort2] = await db
      .insert(cohorts)
      .values({ slug: 'second-cohort', name: 'Second Cohort' })
      .returning();

    const [module2] = await db
      .insert(modules)
      .values({
        cohortId: cohort2!.id,
        slug: 'module-2-b',
        name: 'Module 2B',
        position: 2,
      })
      .returning();

    const [klass2] = await db
      .insert(classes)
      .values({
        cohortId: cohort2!.id,
        moduleId: module2!.id,
        slug: 'class-in-cohort-2',
        name: 'Class in Cohort 2',
        position: 1,
      })
      .returning();

    // Get the original cohort and create its transcript
    const [originalCohort] = await db
      .select()
      .from(cohorts)
      .where(eq(cohorts.slug, 'mobile-dev-cohort'));

    const [originalModule] = await db
      .select()
      .from(modules)
      .where(eq(modules.slug, 'module-7'));

    const [originalClass] = await db
      .select()
      .from(classes)
      .where(eq(classes.slug, 'understanding-the-gyroscope'));

    // Create a transcript in the original cohort (inactive to avoid unique constraint on active)
    const insertTranscriptResult = await pool.query(
      `INSERT INTO transcripts (cohort_id, module_id, class_id, format, source_uri, content_hash, byte_size, is_active)
       VALUES ($1,$2,$3,'vtt','recordings/original.vtt','hash-original',100,false)
       RETURNING id`,
      [originalCohort!.id, originalModule!.id, originalClass!.id],
    );
    const transcriptId = insertTranscriptResult.rows[0]?.id;

    // Now try to create a chunk with the transcript from the original cohort but
    // claiming to belong to cohort2 via the class (composite FK rejects this mismatch)
    await expect(
      (async () => {
        await pool.query(
          `INSERT INTO chunks (
            chunk_key, transcript_id, cohort_id, module_id, class_id, chunk_index,
            text, start_ms, end_ms, token_count, sentence_count,
            chunking_version, tokenizer, embedding_model, embedding_dimensions
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            'chunk-key-xc1',
            transcriptId,
            cohort2!.id, // different cohort from transcript
            module2!.id,
            klass2!.id,
            0,
            'test text',
            0,
            1000,
            10,
            1,
            '1.0',
            'gpt2',
            'text-embedding-3-small',
            1536,
          ],
        );
      })(),
    ).rejects.toThrow();
  });

  test('rejects a chunk whose module_id disagrees with its class', async () => {
    // Get the first class
    const [klass] = await db
      .select()
      .from(classes)
      .where(eq(classes.slug, 'understanding-the-gyroscope'));

    // Create a new module in the same cohort
    const [cohort] = await db.select().from(cohorts).where(eq(cohorts.slug, 'mobile-dev-cohort'));

    const [wrongModule] = await db
      .insert(modules)
      .values({
        cohortId: cohort!.id,
        slug: 'wrong-module-99',
        name: 'Wrong Module',
        position: 99,
      })
      .returning();

    // Create a new class with wrong module for our test chunk to reference
    const [classWithWrongModule] = await db
      .insert(classes)
      .values({
        cohortId: cohort!.id,
        moduleId: wrongModule!.id,
        slug: 'class-with-wrong-mod',
        name: 'Class with Wrong Module',
        position: 88,
      })
      .returning();

    // Create a transcript for the first class (correct module)
    const insertTranscriptResult = await pool.query(
      `INSERT INTO transcripts (cohort_id, module_id, class_id, format, source_uri, content_hash, byte_size, is_active)
       VALUES ($1,$2,$3,'vtt','recordings/test.vtt','hash-test-xyz',100,false)
       RETURNING id`,
      [klass!.cohortId, klass!.moduleId, klass!.id],
    );
    const transcriptId = insertTranscriptResult.rows[0]?.id;

    // Try to create a chunk: it claims to be for classWithWrongModule but points to a transcript
    // from klass. The chunk's module_id will be wrongModule, but classWithWrongModule's actual
    // module is also wrongModule. But the transcript references klass which has a different module.
    // Actually, let me think about this differently.
    // The constraint is: FOREIGN KEY (class_id, module_id) REFERENCES classes (id, module_id)
    // So if I create a chunk with class_id=X and module_id=Y, it must exist as a (X,Y) pair in classes.
    // Let me try: create a chunk that references klass (correct) but with wrongModule (incorrect)
    await expect(
      (async () => {
        await pool.query(
          `INSERT INTO chunks (
            chunk_key, transcript_id, cohort_id, module_id, class_id, chunk_index,
            text, start_ms, end_ms, token_count, sentence_count,
            chunking_version, tokenizer, embedding_model, embedding_dimensions
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            'chunk-key-xm2',
            transcriptId,
            klass!.cohortId,
            wrongModule!.id, // this module doesn't match klass's actual module
            klass!.id, // but we're using klass's id
            0,
            'test text',
            0,
            1000,
            10,
            1,
            '1.0',
            'gpt2',
            'text-embedding-3-small',
            1536,
          ],
        );
      })(),
    ).rejects.toThrow();
  });
});
