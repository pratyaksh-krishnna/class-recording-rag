import type { ChatResponse, Diagnostics } from '@rag/shared';
import type { Database } from '../db/client';
import type { RagConfig } from '../config/rag';
import type { LLMProvider } from '../providers/llm/provider';
import type { EmbeddingProvider } from '../providers/embedding/provider';
import type { Tokenizer } from '../ingestion/tokenizer/tokenizer';
import { AppError } from '../errors/AppError';
import { span } from '../observability/trace';
import { log } from '../observability/logger';
import { getRequestContext, runWithRequestContext } from '../observability/context';
import { contextualize } from './contextualizer';
import { planQueries } from './planner';
import { retrieveHybrid } from './retrieval/hybrid';
import { fuseRRF } from './fusion/rrf';
import { dedupeExactChunkIds } from './context/dedupe';
import { hydrateChunksByIds } from '../db/repositories/chunks.repo';
import { buildContext } from './context/contextBuilder';
import { assessEvidence } from './evidence/judge';
import { generateAnswer } from './generation/answerGenerator';
import { selectHistory, type HistoryMessage } from './conversation/history';
import {
  appendMessage,
  createConversation,
  findConversation,
  listMessages,
  touchConversation,
} from '../db/repositories/conversations.repo';

export interface OrchestratorDeps {
  db: Database;
  llm: LLMProvider;
  embeddings: EmbeddingProvider;
  config: RagConfig;
  tokenizer: Tokenizer;
}

export interface AnswerQuestionInput {
  question: string;
  cohortId: string;
  userId: string;
  conversationId?: string;
}

/**
 * Resolves the conversation for this turn (spec §1.2 step 1). Scoped by
 * BOTH userId and cohortId — never by id alone — so a guessed or shared
 * conversation id can never be read across a boundary (spec §21). An id the
 * caller supplied but that doesn't resolve inside that scope is treated as
 * unknown, not as someone else's conversation.
 */
async function resolveConversationId(
  db: Database,
  input: { conversationId: string | undefined; userId: string; cohortId: string },
): Promise<string> {
  if (input.conversationId === undefined) {
    const created = await createConversation(db, { cohortId: input.cohortId, userId: input.userId });
    return created.id;
  }

  const existing = await findConversation(db, input.conversationId, {
    userId: input.userId,
    cohortId: input.cohortId,
  });
  if (existing === null) {
    throw new AppError('CONVERSATION_NOT_FOUND', 'Conversation not found.');
  }
  return existing.id;
}

/**
 * Runs the full retrieval → generation pipeline for one chat turn (spec
 * §1.2's 10 steps) and persists the result. This is the only module that
 * knows the pipeline's shape — everything it calls is independently tested
 * elsewhere, so this function's job is sequencing, budgeting the shared
 * config/tokenizer into each stage, and turning stage failures into the
 * degradation behavior spec §16.3 requires.
 */
export async function answerQuestion(
  deps: OrchestratorDeps,
  input: AnswerQuestionInput,
): Promise<ChatResponse> {
  const { db, llm, embeddings, config, tokenizer } = deps;
  const { question, cohortId, userId } = input;
  const totalStart = performance.now();

  const conversationId = await resolveConversationId(db, {
    conversationId: input.conversationId,
    userId,
    cohortId,
  });

  const baseContext = getRequestContext() ?? { requestId: 'unknown' };
  const requestId = baseContext.requestId;

  return runWithRequestContext({ ...baseContext, conversationId, userId, cohortId }, async () => {
    // Step 2: load and budget prior turns. Empty on a brand-new conversation,
    // which is exactly what makes contextualize() skip its LLM call below.
    const priorMessages: HistoryMessage[] = (await listMessages(db, conversationId)).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const history = selectHistory(priorMessages, config.budgets.conversationHistoryTokens, tokenizer);

    // Step 3: contextualize. Never throws — a failure degrades to the raw
    // question (spec §16.3), so no try/catch is needed at this layer.
    const { result: contextualizeResult, durationMs: contextualizeMs } = await span(
      'chat.contextualize',
      () =>
        contextualize(
          { llm, reasoningEffort: config.llm.reasoningEffort.contextualizer, timeoutMs: config.llm.timeoutMs },
          { question, history },
        ),
      { skippedOnFirstTurn: history.length === 0 },
    );
    const standaloneQuery = contextualizeResult.standaloneQuery;

    // Step 4: plan queries. Also never throws — a failure degrades to a
    // single-query plan (spec §16.3).
    const { result: planResult, durationMs: planMs } = await span(
      'chat.plan',
      () =>
        planQueries(
          { llm, reasoningEffort: config.llm.reasoningEffort.planner, timeoutMs: config.llm.timeoutMs, limits: config.retrieval },
          { standaloneQuery, history },
        ),
      {},
    );

    // Step 5: parallel hybrid retrieval. Throws RETRIEVAL_FAILED only when
    // every one of the 2×N tasks failed (spec §16.3) — that's allowed to
    // propagate to the caller as-is.
    const { result: hybridResult, durationMs: retrieveMs } = await span(
      'chat.retrieve',
      () => retrieveHybrid({ db, embeddings, config }, { cohortId, queries: planResult.queries }),
      { queryCount: planResult.queries.length },
    );

    // Step 6: fuse, then step 7: dedupe (a documented near-no-op — see
    // dedupe.ts — kept as its own named, testable step).
    const { result: fused } = await span(
      'chat.fuse',
      () => Promise.resolve(fuseRRF(hybridResult.lists, config.rrf.k)),
      { listCount: hybridResult.lists.length },
    );
    const deduped = dedupeExactChunkIds(fused);

    // Step 8: hydrate + build context. Hydration is cohort-scoped so a fused
    // chunk id from another cohort (which should never occur, but defense in
    // depth costs nothing here) can never surface.
    const { result: builtContext } = await span(
      'chat.context',
      async () => {
        const hydrated = await hydrateChunksByIds(db, deduped.map((c) => c.chunkId), cohortId);
        return buildContext(hydrated, tokenizer, config.budgets.contextTokens);
      },
      { fusedCount: deduped.length },
    );

    // Step 9: evidence assessment. Never throws — a failure degrades to
    // 'partial'/'insufficient' (spec §16.3).
    const { result: assessment, durationMs: judgeMs } = await span(
      'chat.judge',
      () =>
        assessEvidence(
          { llm, reasoningEffort: config.llm.reasoningEffort.judge, timeoutMs: config.llm.timeoutMs },
          { question: standaloneQuery, contextText: builtContext.contextText, evidence: builtContext.evidence },
        ),
      {},
    );

    // Step 10: answer generation + citation validation (citationValidator is
    // invoked inside generateAnswer itself). Throws LLM_FAILED after one
    // retry (spec §16.3) — allowed to propagate.
    const { result: generateResult, durationMs: generateMs } = await span(
      'chat.generate',
      () =>
        generateAnswer(
          { llm, reasoningEffort: config.llm.reasoningEffort.answer, timeoutMs: config.llm.timeoutMs },
          {
            question: standaloneQuery,
            contextText: builtContext.contextText,
            evidence: builtContext.evidence,
            verdict: assessment.verdict,
            history,
            allowGeneralKnowledgeFallback: config.features.allowGeneralKnowledgeFallback,
          },
        ),
      { verdict: assessment.verdict },
    );

    if (generateResult.fabricatedIds.length > 0) {
      log().warn({ fabricatedIds: generateResult.fabricatedIds }, 'citation.fabricated');
    }

    // Step 11: persist. User message first, then the assistant message with
    // its citations in the same order sources() returned them, then bump
    // updated_at so this conversation sorts first in a listing.
    await appendMessage(db, { conversationId, role: 'user', content: question });
    const assistantMessage = await appendMessage(db, {
      conversationId,
      role: 'assistant',
      content: generateResult.answer,
      groundingStatus: generateResult.groundingStatus,
      citations: generateResult.sources.map((source) => ({ chunkId: source.chunkId, sourceId: source.id })),
    });
    await touchConversation(db, conversationId);

    const totalMs = Math.round(performance.now() - totalStart);
    const latencyMs: Diagnostics['latencyMs'] = {
      ...(contextualizeResult.skipped ? {} : { contextualize: contextualizeMs }),
      plan: planMs,
      retrieve: retrieveMs,
      judge: judgeMs,
      generate: generateMs,
      total: totalMs,
    };

    log().info(
      {
        groundingStatus: generateResult.groundingStatus,
        judgeVerdict: assessment.verdict,
        queryCount: planResult.queries.length,
        fusedCount: deduped.length,
        contextChunkCount: builtContext.includedChunkIds.length,
        contextTokens: builtContext.contextTokens,
        citedSourceCount: generateResult.sources.length,
        regenerated: generateResult.regenerated,
        latencyMs,
      },
      'chat.request completed',
    );

    const response: ChatResponse = {
      conversationId,
      messageId: assistantMessage.id,
      answer: generateResult.answer,
      groundingStatus: generateResult.groundingStatus,
      sources: generateResult.sources,
    };

    if (config.features.diagnosticsEnabled) {
      response.diagnostics = {
        requestId,
        queries: planResult.queries.map((q) => ({ label: q.label, text: q.text })),
        retrieval: hybridResult.diagnostics,
        fusedCount: deduped.length,
        contextChunkCount: builtContext.includedChunkIds.length,
        contextTokens: builtContext.contextTokens,
        judgeVerdict: assessment.verdict,
        latencyMs,
      };
    }

    return response;
  });
}
