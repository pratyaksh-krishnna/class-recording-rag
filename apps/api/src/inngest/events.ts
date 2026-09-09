import { eventType } from 'inngest';
import { z } from 'zod';

export const TranscriptIngestRequestedSchema = z.object({
  transcriptId: z.string().uuid(),
  classId: z.string().uuid(),
  cohortId: z.string().uuid(),
  sourceUri: z.string().min(1),
  requestedBy: z.string().min(1),
});

export const TranscriptReindexRequestedSchema = z.object({
  transcriptId: z.string().uuid(),
  chunkingVersion: z.string().min(1),
  embeddingModel: z.string().min(1),
});

export type TranscriptIngestRequested = z.infer<typeof TranscriptIngestRequestedSchema>;
export type TranscriptReindexRequested = z.infer<typeof TranscriptReindexRequestedSchema>;

export type Events = {
  'transcript.ingest.requested': {
    data: TranscriptIngestRequested;
  };
  'transcript.reindex.requested': {
    data: TranscriptReindexRequested;
  };
};

/**
 * The typed event definitions used as function triggers and at every send site.
 * Inngest validates `data` against these Standard Schemas on the way in, which
 * is why each function can still re-parse defensively without duplicating the
 * shape (a worker treats a delivered payload as untrusted input).
 */
export const transcriptIngestRequested = eventType('transcript.ingest.requested', {
  schema: TranscriptIngestRequestedSchema,
});

export const transcriptReindexRequested = eventType('transcript.reindex.requested', {
  schema: TranscriptReindexRequestedSchema,
});
