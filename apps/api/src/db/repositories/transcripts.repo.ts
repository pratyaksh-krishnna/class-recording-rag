import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { transcripts } from '../schema';

export interface UpsertTranscriptInput {
  cohortId: string;
  moduleId: string;
  classId: string;
  format: 'srt' | 'vtt';
  sourceUri: string;
  contentHash: string;
  byteSize: number;
  language?: string;
}

export interface TranscriptRow {
  id: string;
  cohortId: string;
  moduleId: string;
  classId: string;
  format: 'srt' | 'vtt';
  sourceUri: string;
  contentHash: string;
  byteSize: number;
  language: string;
  cueCount: number | null;
  durationMs: number | null;
  isActive: boolean;
}

/**
 * UNIQUE (class_id, content_hash) is the ingestion idempotency anchor (spec
 * §5.4): identical bytes re-uploaded for the same class resolve to the same
 * row, `created: false`, and nothing else in the table is touched.
 *
 * A genuinely new transcript must become the class's one active transcript,
 * but `transcripts_one_active_per_class` is a partial unique index on
 * is_active — so the old active row(s) must flip to inactive in the SAME
 * transaction as the insert, or the insert would violate that index (spec
 * §7.2).
 */
export async function upsertTranscript(
  db: Database,
  input: UpsertTranscriptInput,
): Promise<{ id: string; created: boolean }> {
  const [existing] = await db
    .select({ id: transcripts.id })
    .from(transcripts)
    .where(and(eq(transcripts.classId, input.classId), eq(transcripts.contentHash, input.contentHash)));

  if (existing) {
    return { id: existing.id, created: false };
  }

  return db.transaction(async (tx) => {
    await tx
      .update(transcripts)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(transcripts.classId, input.classId), eq(transcripts.isActive, true)));

    const [row] = await tx
      .insert(transcripts)
      .values({
        cohortId: input.cohortId,
        moduleId: input.moduleId,
        classId: input.classId,
        format: input.format,
        sourceUri: input.sourceUri,
        contentHash: input.contentHash,
        byteSize: input.byteSize,
        language: input.language ?? 'en',
        isActive: true,
      })
      .returning({ id: transcripts.id });

    if (!row) throw new Error('upsertTranscript: insert returned no row');
    return { id: row.id, created: true };
  });
}

export async function findTranscriptById(db: Database, id: string): Promise<TranscriptRow | null> {
  const [row] = await db
    .select({
      id: transcripts.id,
      cohortId: transcripts.cohortId,
      moduleId: transcripts.moduleId,
      classId: transcripts.classId,
      format: transcripts.format,
      sourceUri: transcripts.sourceUri,
      contentHash: transcripts.contentHash,
      byteSize: transcripts.byteSize,
      language: transcripts.language,
      cueCount: transcripts.cueCount,
      durationMs: transcripts.durationMs,
      isActive: transcripts.isActive,
    })
    .from(transcripts)
    .where(eq(transcripts.id, id));
  return row ?? null;
}

export async function updateTranscriptStats(
  db: Database,
  id: string,
  stats: { cueCount: number; durationMs: number },
): Promise<void> {
  await db
    .update(transcripts)
    .set({ cueCount: stats.cueCount, durationMs: stats.durationMs, updatedAt: new Date() })
    .where(eq(transcripts.id, id));
}
