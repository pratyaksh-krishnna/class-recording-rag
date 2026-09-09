/**
 * Testable core of transcript seeding (spec §7.3). Pure logic: no filesystem,
 * no argv, every function accepts and returns only its arguments. Tests inject
 * fake deps; production swaps in real database and file I/O.
 */

import type { SeedManifest } from './manifest';

export interface SeedDeps {
  upsertCohort(input: { slug: string; name: string }): Promise<{ id: string }>;
  upsertModule(input: { cohortId: string; slug: string; name: string; position: number }): Promise<{ id: string }>;
  upsertClass(input: { cohortId: string; moduleId: string; slug: string; name: string; position: number }): Promise<{ id: string }>;
  upsertTranscript(input: {
    cohortId: string;
    moduleId: string;
    classId: string;
    format: 'srt' | 'vtt';
    sourceUri: string;
    contentHash: string;
    byteSize: number;
  }): Promise<{ id: string; created: boolean }>;
  readSource(sourceUri: string): Promise<{ content: string; byteSize: number; contentHash: string }>;
  emit(event: { transcriptId: string; classId: string; cohortId: string; sourceUri: string; requestedBy: string }): Promise<void>;
}

export interface SeedSummary {
  cohortId: string;
  modules: number;
  classes: number;
  transcriptsCreated: number;
  transcriptsExisting: number;
  eventsEmitted: number;
}

/**
 * Idempotent seeding: upsert the cohort, then each module, then each class,
 * then read each source file to get its hash and byte size, then upsert the
 * transcript. Emit one transcript.ingest.requested per transcript ONLY when
 * options.emitEvents is true.
 *
 * Because upsertTranscript keys on (class_id, content_hash), a second run
 * over unchanged files must report transcriptsCreated: 0 — that idempotency
 * is the whole point.
 *
 * Classes are processed sequentially. Fan-out and concurrency belong to
 * Inngest, not this script.
 */
export async function seedManifest(
  manifest: SeedManifest,
  deps: SeedDeps,
  options: { requestedBy: string; emitEvents: boolean },
): Promise<SeedSummary> {
  // Upsert cohort
  const cohortResult = await deps.upsertCohort({
    slug: manifest.cohort.slug,
    name: manifest.cohort.name,
  });
  const cohortId = cohortResult.id;

  let moduleCount = 0;
  let classCount = 0;
  let transcriptsCreated = 0;
  let transcriptsExisting = 0;
  let eventsEmitted = 0;

  // Upsert modules and classes sequentially
  for (const module of manifest.modules) {
    const moduleResult = await deps.upsertModule({
      cohortId,
      slug: module.slug,
      name: module.name,
      position: module.position,
    });
    const moduleId = moduleResult.id;
    moduleCount++;

    for (const klass of module.classes) {
      const classResult = await deps.upsertClass({
        cohortId,
        moduleId,
        slug: klass.slug,
        name: klass.name,
        position: klass.position,
      });
      const classId = classResult.id;
      classCount++;

      // Read source file to get hash and byte size
      const source = await deps.readSource(klass.sourceUri);

      // Upsert transcript with hash-based idempotency
      const transcriptResult = await deps.upsertTranscript({
        cohortId,
        moduleId,
        classId,
        format: klass.format,
        sourceUri: klass.sourceUri,
        contentHash: source.contentHash,
        byteSize: source.byteSize,
      });
      const transcriptId = transcriptResult.id;

      if (transcriptResult.created) {
        transcriptsCreated++;
      } else {
        transcriptsExisting++;
      }

      // Emit event only when requested
      if (options.emitEvents) {
        await deps.emit({
          transcriptId,
          classId,
          cohortId,
          sourceUri: klass.sourceUri,
          requestedBy: options.requestedBy,
        });
        eventsEmitted++;
      }
    }
  }

  return {
    cohortId,
    modules: moduleCount,
    classes: classCount,
    transcriptsCreated,
    transcriptsExisting,
    eventsEmitted,
  };
}
