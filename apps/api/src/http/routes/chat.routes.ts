import { Router } from 'express';
import { AppError } from '../../errors/AppError';
import { answerQuestion, type OrchestratorDeps } from '../../rag/orchestrator';
import { findConversation, listConversations, listMessagesWithCitations } from '../../db/repositories/conversations.repo';
import { requireCohortContext } from '../middleware/requireCohortContext';
import { ChatRequestSchema, ConversationIdParamSchema } from '../validation/chat';

/**
 * `POST /api/chat`, `GET /api/conversations/:id`, `GET /api/conversations`
 * (spec §16.1, §16.2). Controllers stay thin: validate, call the orchestrator
 * or a repo, shape the HTTP response — no RAG logic lives here. Every read is
 * scoped by both `req.userId` and `req.cohortId`, set by requireCohortContext.
 */
export function createChatRouter(deps: OrchestratorDeps): Router {
  const router = Router();

  router.post('/api/chat', requireCohortContext, async (req, res, next) => {
    try {
      const parsed = ChatRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', 'Invalid chat request.', { details: parsed.error.flatten() });
      }

      const response = await answerQuestion(deps, {
        question: parsed.data.question,
        cohortId: req.cohortId,
        userId: req.userId,
        ...(parsed.data.conversationId !== undefined ? { conversationId: parsed.data.conversationId } : {}),
      });

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/conversations/:id', requireCohortContext, async (req, res, next) => {
    try {
      const parsed = ConversationIdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', 'Invalid conversation id.', { details: parsed.error.flatten() });
      }

      const conversation = await findConversation(deps.db, parsed.data.id, {
        userId: req.userId,
        cohortId: req.cohortId,
      });
      if (!conversation) {
        throw new AppError('CONVERSATION_NOT_FOUND', 'Conversation not found.');
      }

      const messages = await listMessagesWithCitations(deps.db, conversation.id);
      res.status(200).json({ conversationId: conversation.id, messages });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/conversations', requireCohortContext, async (req, res, next) => {
    try {
      const conversations = await listConversations(deps.db, { userId: req.userId, cohortId: req.cohortId });
      res.status(200).json({ conversations });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
