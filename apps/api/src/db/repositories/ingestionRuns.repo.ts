import { desc, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { ingestionRuns } from '../schema';

export type IngestionRunStatus =
  | 'pending'
  | 'parsing'
  | 'chunking'
  | 'persisting'
  | 'embedding'
  | 'completed'
  | 'failed';

export interface CreateRunInput {
  classId: string;
  transcriptId?: string | null;
  eventId?: string | null;
  status: IngestionRunStatus;
  chunkingVersion: string;
  embeddingModel: string;
}

export interface UpdateRunStatusFields {
  cueCount?: number;
  sentenceCount?: number;
  chunkCount?: number;
  embeddedCount?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface IngestionRunRow {
  id: string;
  transcriptId: string | null;
  classId: string;
  eventId: string | null;
  status: IngestionRunStatus;
  chunkingVersion: string;
  embeddingModel: string;
  cueCount: number | null;
  sentenceCount: number | null;
  chunkCount: number | null;
  embeddedCount: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export async function createRun(db: Database, input: CreateRunInput): Promise<{ id: string }> {
  const [row] = await db
    .insert(ingestionRuns)
    .values({
      classId: input.classId,
      transcriptId: input.transcriptId ?? null,
      eventId: input.eventId ?? null,
      status: input.status,
      chunkingVersion: input.chunkingVersion,
      embeddingModel: input.embeddingModel,
    })
    .returning({ id: ingestionRuns.id });

  if (!row) throw new Error('createRun: insert returned no row');
  return row;
}

/**
 * `finished_at` is set automatically the moment status lands on a terminal
 * value ('completed' or 'failed') — callers never pass it explicitly, so a
 * step cannot forget to close out a run.
 */
export async function updateRunStatus(
  db: Database,
  id: string,
  status: IngestionRunStatus,
  fields?: UpdateRunStatusFields,
): Promise<void> {
  const isTerminal = status === 'completed' || status === 'failed';

  await db
    .update(ingestionRuns)
    .set({
      status,
      ...(fields?.cueCount !== undefined ? { cueCount: fields.cueCount } : {}),
      ...(fields?.sentenceCount !== undefined ? { sentenceCount: fields.sentenceCount } : {}),
      ...(fields?.chunkCount !== undefined ? { chunkCount: fields.chunkCount } : {}),
      ...(fields?.embeddedCount !== undefined ? { embeddedCount: fields.embeddedCount } : {}),
      ...(fields?.errorCode !== undefined ? { errorCode: fields.errorCode } : {}),
      ...(fields?.errorMessage !== undefined ? { errorMessage: fields.errorMessage } : {}),
      ...(isTerminal ? { finishedAt: new Date() } : {}),
    })
    .where(eq(ingestionRuns.id, id));
}

export async function findRunById(db: Database, id: string): Promise<IngestionRunRow | null> {
  const [row] = await db.select().from(ingestionRuns).where(eq(ingestionRuns.id, id));
  return row ?? null;
}

/**
 * A transcript can be ingested more than once (a retried upload, a reindex),
 * so "the run" for a transcript means the newest one — the run whose status
 * the caller polling `GET /api/transcripts/:id` actually means. Returns null
 * when the transcript has no run yet, which is a valid state, not an error.
 */
export async function findLatestRunByTranscriptId(
  db: Database,
  transcriptId: string,
): Promise<IngestionRunRow | null> {
  const [row] = await db
    .select()
    .from(ingestionRuns)
    .where(eq(ingestionRuns.transcriptId, transcriptId))
    .orderBy(desc(ingestionRuns.startedAt))
    .limit(1);
  return row ?? null;
}
