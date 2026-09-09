import { z } from 'zod';

export const ChatRequestSchema = z.object({
  question: z.string().min(1).max(2000),
  conversationId: z.string().uuid('conversationId must be a uuid').optional(),
});

export type ChatRequestInput = z.infer<typeof ChatRequestSchema>;

export const ConversationIdParamSchema = z.object({
  id: z.string().uuid('id must be a uuid'),
});
