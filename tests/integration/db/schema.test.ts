import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { runMigrations } from '../../../apps/api/migrations/run';
import { createPool, createDb, closePool } from '../../../apps/api/src/db/client';
import { cohorts, modules, classes } from '../../../apps/api/src/db/schema';
import type { Pool } from 'pg';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('drizzle schema', () => {
  const url = TEST_DATABASE_URL as string;
  let pool: Pool;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
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
});
