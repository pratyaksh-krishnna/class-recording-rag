import { eq } from 'drizzle-orm';
import type { Database } from '../client';
import { classes } from '../schema';

export interface UpsertClassInput {
  cohortId: string;
  moduleId: string;
  slug: string;
  name: string;
  position: number;
  // V2 placeholders (spec §3.1) — nullable, unread by anything in V1.
  recordingId?: string | null;
  recordingUrl?: string | null;
}

export interface ClassRow {
  id: string;
  cohortId: string;
  moduleId: string;
  slug: string;
  name: string;
  position: number;
  recordingId: string | null;
  recordingUrl: string | null;
}

/**
 * ON CONFLICT (module_id, slug): re-running the seed script updates name,
 * position, and recording fields without duplicating a class row. cohort_id
 * is not part of the conflict target — a class never changes module without
 * changing slug, per the manifest workflow (spec §2 #7).
 */
export async function upsertClass(db: Database, input: UpsertClassInput): Promise<{ id: string }> {
  const [row] = await db
    .insert(classes)
    .values({
      cohortId: input.cohortId,
      moduleId: input.moduleId,
      slug: input.slug,
      name: input.name,
      position: input.position,
      recordingId: input.recordingId ?? null,
      recordingUrl: input.recordingUrl ?? null,
    })
    .onConflictDoUpdate({
      target: [classes.moduleId, classes.slug],
      set: {
        name: input.name,
        position: input.position,
        recordingId: input.recordingId ?? null,
        recordingUrl: input.recordingUrl ?? null,
        updatedAt: new Date(),
      },
    })
    .returning({ id: classes.id });

  if (!row) throw new Error('upsertClass: insert/update returned no row');
  return row;
}

export async function findClassById(db: Database, id: string): Promise<ClassRow | null> {
  const [row] = await db
    .select({
      id: classes.id,
      cohortId: classes.cohortId,
      moduleId: classes.moduleId,
      slug: classes.slug,
      name: classes.name,
      position: classes.position,
      recordingId: classes.recordingId,
      recordingUrl: classes.recordingUrl,
    })
    .from(classes)
    .where(eq(classes.id, id));
  return row ?? null;
}
