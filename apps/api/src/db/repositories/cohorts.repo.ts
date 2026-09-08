import { eq } from 'drizzle-orm';
import type { Database } from '../client';
import { cohorts } from '../schema';

export interface UpsertCohortInput {
  slug: string;
  name: string;
}

export interface CohortRow {
  id: string;
  slug: string;
  name: string;
}

/**
 * ON CONFLICT (slug): re-running the seed script (spec §7.3) with an edited
 * name in seed.manifest.json updates the row in place instead of erroring.
 */
export async function upsertCohort(db: Database, input: UpsertCohortInput): Promise<CohortRow> {
  const [row] = await db
    .insert(cohorts)
    .values({ slug: input.slug, name: input.name })
    .onConflictDoUpdate({
      target: cohorts.slug,
      set: { name: input.name, updatedAt: new Date() },
    })
    .returning({ id: cohorts.id, slug: cohorts.slug, name: cohorts.name });

  if (!row) throw new Error('upsertCohort: insert/update returned no row');
  return row;
}

export async function findCohortById(db: Database, id: string): Promise<CohortRow | null> {
  const [row] = await db
    .select({ id: cohorts.id, slug: cohorts.slug, name: cohorts.name })
    .from(cohorts)
    .where(eq(cohorts.id, id));
  return row ?? null;
}

export async function findCohortBySlug(db: Database, slug: string): Promise<CohortRow | null> {
  const [row] = await db
    .select({ id: cohorts.id, slug: cohorts.slug, name: cohorts.name })
    .from(cohorts)
    .where(eq(cohorts.slug, slug));
  return row ?? null;
}
