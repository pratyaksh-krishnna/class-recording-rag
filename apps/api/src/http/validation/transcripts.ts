import { z } from 'zod';

/**
 * Multer places every non-file multipart field on `req.body` as a string
 * (or an array of strings for a repeated field), never a parsed type — so
 * `classId` and `language` are validated as strings, not as some richer
 * shape a JSON body would allow.
 */
export const CreateTranscriptFieldsSchema = z.object({
  classId: z.string().uuid('classId must be a uuid'),
  language: z.string().min(1).max(32).optional(),
});

export type CreateTranscriptFields = z.infer<typeof CreateTranscriptFieldsSchema>;

export const TranscriptIdParamSchema = z.object({
  id: z.string().uuid('id must be a uuid'),
});

export type TranscriptIdParam = z.infer<typeof TranscriptIdParamSchema>;
