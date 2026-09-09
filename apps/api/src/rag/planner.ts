import type { LLMProvider } from '../providers/llm/provider';
import type { ReasoningEffort } from '../config/env.schema';
import type { HistoryMessage } from './conversation/history';
import { QueryPlanSchema } from './schemas/index';
import { normalizeQueryPlan, fallbackPlan, type NormalizedQuery, type QueryPlanLimits } from './schemas/normalize';
import { log } from '../observability/logger';

export interface PlanQueriesDeps {
  llm: LLMProvider;
  reasoningEffort: ReasoningEffort;
  timeoutMs: number;
  limits: QueryPlanLimits;
}

export interface PlanQueriesInput {
  standaloneQuery: string;
  history: HistoryMessage[];
}

export interface PlanQueriesResult {
  queries: NormalizedQuery[];
  /** Logged only — never returned to the user (spec §9). */
  rationale: string;
}

// Deliberately no module/class catalogue in this prompt (spec §9): the
// planner's job is query formulation, not course navigation, and feeding it
// 87 class titles would bias it toward titles that happen to match wording.
const SYSTEM_PROMPT = `You are the query planner for a course-recordings retrieval system.

Given a standalone question (and recent conversation for context), decide whether additional search queries would improve retrieval, and produce them. You do not have and should not assume any list of course modules or classes — work only from the wording and meaning of the question itself.

Respond with:
- contextualizedQuery: echo back the standalone question you were given, unchanged.
- rewrittenQuery: an alternative phrasing likely to match different transcript wording, or null if the original phrasing is already good.
- stepBackQuery: a broader, more general version of the question that surfaces foundational context, or null if the question is already broad.
- subQueries: up to 3 focused sub-questions that decompose a multi-part question, or [] if the question is already a single, focused query.
- rationale: one or two sentences on why you chose these transformations. This is for internal logging only and is never shown to a user.

Do not force a question through every transformation — a simple, focused question should get null/[] for most fields.`;

function renderHistory(history: HistoryMessage[]): string {
  return history.map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`).join('\n');
}

function buildUserPrompt(standaloneQuery: string, history: HistoryMessage[]): string {
  const historyBlock = history.length > 0 ? `Conversation history:\n${renderHistory(history)}\n\n` : '';
  return `${historyBlock}Standalone question: ${standaloneQuery}`;
}

/**
 * Turns a standalone query into the set of queries retrieval will run (spec
 * §9). Planner output is untrusted input, so the raw LLM result always passes
 * through normalizeQueryPlan before use. Any failure yields fallbackPlan —
 * retrieval always has something to run.
 */
export async function planQueries(deps: PlanQueriesDeps, input: PlanQueriesInput): Promise<PlanQueriesResult> {
  try {
    const result = await deps.llm.complete({
      schemaName: 'query_plan',
      schema: QueryPlanSchema,
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(input.standaloneQuery, input.history),
      reasoningEffort: deps.reasoningEffort,
      timeoutMs: deps.timeoutMs,
    });

    const queries = normalizeQueryPlan(result.value, input.standaloneQuery, deps.limits);
    return { queries, rationale: result.value.rationale };
  } catch {
    // No error content logged here — it may wrap upstream text (spec §20).
    log().warn({ schemaName: 'query_plan' }, 'planner failed; falling back to single-query plan');
    return { queries: fallbackPlan(input.standaloneQuery), rationale: '' };
  }
}
