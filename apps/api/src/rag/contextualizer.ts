import type { LLMProvider } from '../providers/llm/provider';
import type { ReasoningEffort } from '../config/env.schema';
import type { HistoryMessage } from './conversation/history';
import { ContextualizedQuerySchema } from './schemas/index';
import { log } from '../observability/logger';

export interface ContextualizeInput {
  question: string;
  history: HistoryMessage[];
}

export interface ContextualizeResult {
  standaloneQuery: string;
  usedHistory: boolean;
  skipped: boolean;
  resolvedReferences: string[];
}

export interface ContextualizeDeps {
  llm: LLMProvider;
  reasoningEffort: ReasoningEffort;
  timeoutMs: number;
}

const SYSTEM_PROMPT = `You are the conversation contextualizer for a course-recordings Q&A assistant.

Given the recent conversation history and the user's latest question, rewrite the question as a standalone query that a search system can use without seeing the conversation. Resolve pronouns and implicit references — "it", "that", "the second one", "what about X" — by substituting in the specific term or concept the history shows them referring to. If the question is already standalone, return it unchanged.

Respond with:
- standaloneQuery: the rewritten, standalone question (or the original question, if no rewriting was needed). Concise and search-friendly.
- usedHistory: true only if you needed the history to produce standaloneQuery.
- resolvedReferences: each reference you resolved, written as "reference -> resolution" (e.g. "it -> normalization"). Empty array if none were needed.

Do not answer the question. Do not add information the conversation does not support.`;

function renderHistory(history: HistoryMessage[]): string {
  return history.map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`).join('\n');
}

function buildUserPrompt(question: string, history: HistoryMessage[]): string {
  return `Conversation history:\n${renderHistory(history)}\n\nCurrent question: ${question}`;
}

/**
 * Resolves the current question against conversation history into a
 * standalone search query (spec §8). Skipped entirely on a first turn — a
 * first question is already standalone, and spending a call to discover that
 * is waste. Any LLM failure (timeout, schema violation, refusal) falls back
 * to the raw question: degraded retrieval beats a failed request.
 */
export async function contextualize(
  deps: ContextualizeDeps,
  input: ContextualizeInput,
): Promise<ContextualizeResult> {
  const { question, history } = input;

  if (history.length === 0) {
    return { standaloneQuery: question, usedHistory: false, skipped: true, resolvedReferences: [] };
  }

  try {
    const result = await deps.llm.complete({
      schemaName: 'contextualized_query',
      schema: ContextualizedQuerySchema,
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(question, history),
      reasoningEffort: deps.reasoningEffort,
      timeoutMs: deps.timeoutMs,
    });

    return {
      standaloneQuery: result.value.standaloneQuery,
      usedHistory: result.value.usedHistory,
      skipped: false,
      resolvedReferences: result.value.resolvedReferences,
    };
  } catch {
    // No error content logged here — it may wrap upstream text (spec §20).
    log().warn({ schemaName: 'contextualized_query' }, 'contextualizer failed; falling back to raw question');
    return { standaloneQuery: question, usedHistory: false, skipped: false, resolvedReferences: [] };
  }
}
