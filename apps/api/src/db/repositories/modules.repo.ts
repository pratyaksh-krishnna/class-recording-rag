import { asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../client';
import { classes, modules } from '../schema';

export interface UpsertModuleInput {
  cohortId: string;
  slug: string;
  name: string;
  position: number;
}

export interface ModuleWithClasses {
  id: string;
  slug: string;
  name: string;
  position: number;
  classes: Array<{ id: string; slug: string; name: string; position: number }>;
}

/**
 * ON CONFLICT (cohort_id, slug): re-running the seed script updates name and
 * position without duplicating a module row.
 */
export async function upsertModule(db: Database, input: UpsertModuleInput): Promise<{ id: string }> {
  const [row] = await db
    .insert(modules)
    .values({
      cohortId: input.cohortId,
      slug: input.slug,
      name: input.name,
      position: input.position,
    })
    .onConflictDoUpdate({
      target: [modules.cohortId, modules.slug],
      set: { name: input.name, position: input.position, updatedAt: new Date() },
    })
    .returning({ id: modules.id });

  if (!row) throw new Error('upsertModule: insert/update returned no row');
  return row;
}

/**
 * Powers the catalog endpoint (spec §16.2). Two queries rather than a join so
 * a module with zero classes still appears, with an empty `classes` array.
 */
export async function listModulesWithClasses(
  db: Database,
  cohortId: string,
): Promise<ModuleWithClasses[]> {
  const moduleRows = await db
    .select({
      id: modules.id,
      slug: modules.slug,
      name: modules.name,
      position: modules.position,
    })
    .from(modules)
    .where(eq(modules.cohortId, cohortId))
    .orderBy(asc(modules.position));

  if (moduleRows.length === 0) return [];

  const moduleIds = moduleRows.map((m) => m.id);
  const classRows = await db
    .select({
      id: classes.id,
      moduleId: classes.moduleId,
      slug: classes.slug,
      name: classes.name,
      position: classes.position,
    })
    .from(classes)
    .where(inArray(classes.moduleId, moduleIds))
    .orderBy(asc(classes.position));

  const classesByModuleId = new Map<string, ModuleWithClasses['classes']>();
  for (const c of classRows) {
    const bucket = classesByModuleId.get(c.moduleId);
    const entry = { id: c.id, slug: c.slug, name: c.name, position: c.position };
    if (bucket) {
      bucket.push(entry);
    } else {
      classesByModuleId.set(c.moduleId, [entry]);
    }
  }

  return moduleRows.map((m) => ({
    id: m.id,
    slug: m.slug,
    name: m.name,
    position: m.position,
    classes: classesByModuleId.get(m.id) ?? [],
  }));
}
