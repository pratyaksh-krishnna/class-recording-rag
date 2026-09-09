import type { GroundingStatus, Source } from '@rag/shared';
import { AppError } from '../../errors/AppError';
import type { LLMProvider, LLMRequest } from '../../providers/llm/provider';
import type { HistoryMessage } from '../conversation/history';
import type { EvidenceMap } from '../context/contextBuilder';
import { toSources } from '../context/sources';
import { AnswerSchema, type Answer, type EvidenceAssessment } from '../schemas';
import { groundingPromptFor } from './prompts';
import { stripInvalidMarkers, validateCitations } from './citationValidator';

// provider.ts has no exported name for this union — it only appears inline
// on LLMRequest. Derived rather than duplicated, so the two can't drift.
export type ReasoningEffort = LLMRequest<unknown>['reasoningEffort'];

export interface GenerateInput {
  question: string;
  contextText: string;
  evidence: EvidenceMap;
  verdict: EvidenceAssessment['verdict'];
  history: HistoryMessage[];
  allowGeneralKnowledgeFallback: boolean;
}

export interface GenerateResult {
  answer: string;
  groundingStatus: GroundingStatus;
  sources: Source[];
  citedSourceIds: string[];
  regenerated: boolean;
  fabricatedIds: string[];
}

/** Verdict → resulting status, spec §14's table. */
const STATUS_BY_VERDICT: Record<EvidenceAssessment['verdict'], GroundingStatus> = {
  sufficient: 'course_grounded',
  partial: 'partially_grounded',
  insufficient: 'general_knowledge',
  conflicting: 'conflicting',
};

function renderHistory(history: HistoryMessage[]): string {
  if (history.length === 0) return '(no prior conversation)';
  return history.map((m) => `${m.role === 'user' ? 'Student' : 'Assistant'}: ${m.content}`).join('\n');
}

function buildUserPrompt(input: {
  question: string;
  contextText: string;
  history: HistoryMessage[];
  allowGeneralKnowledgeFallback: boolean;
}): string {
  return [
    `Conversation so far:\n${renderHistory(input.history)}`,
    `Sources:\n${input.contextText}`,
    `General-knowledge fallback: ${input.allowGeneralKnowledgeFallback ? 'enabled' : 'disabled'}`,
    `Question: ${input.question}`,
  ].join('\n\n');
}

/** The one corrective message spec §14.1 step 3 allows, naming the valid ids. */
function buildCorrectiveUserPrompt(baseUser: string, validIds: string[], invalidIds: string[]): string {
  const correction = [
    'Your previous answer cited one or more [SOURCE_N] ids that do not exist among the supplied sources:',
    `Invalid: ${invalidIds.join(', ')}`,
    `Valid source ids you may cite: ${validIds.length > 0 ? validIds.join(', ') : '(none)'}`,
    'Regenerate the answer using only the valid source ids above. Do not invent any other id.',
  ].join('\n');
  return `${correction}\n\n${baseUser}`;
}

/**
 * One structured-output call, with exactly one retry on failure — a network
 * blip or a malformed response, not a citation problem (spec §16.3:
 * "generation failure after one retry -> LLM_FAILED").
 */
async function completeAnswer(
  deps: { llm: LLMProvider; reasoningEffort: ReasoningEffort; timeoutMs: number },
  system: string,
  user: string,
): Promise<Answer> {
  const request: LLMRequest<Answer> = {
    schemaName: 'answer',
    schema: AnswerSchema,
    system,
    user,
    reasoningEffort: deps.reasoningEffort,
    timeoutMs: deps.timeoutMs,
  };

  try {
    return (await deps.llm.complete(request)).value;
  } catch (firstError) {
    try {
      return (await deps.llm.complete(request)).value;
    } catch (secondError) {
      throw new AppError('LLM_FAILED', 'Answer generation failed.', { cause: secondError });
    }
  }
}

/**
 * Implements spec §14.1 exactly: generate, validate every extracted marker
 * against the evidence map, one regeneration attempt if any are invalid,
 * strip-and-downgrade if it's still invalid, then build `sources` only from
 * what validated. The prose's `[SOURCE_N]` markers are authoritative
 * throughout — the model's `citedSourceIds` field is never read.
 */
export async function generateAnswer(
  deps: { llm: LLMProvider; reasoningEffort: ReasoningEffort; timeoutMs: number },
  input: GenerateInput,
): Promise<GenerateResult> {
  const { question, contextText, evidence, verdict, history, allowGeneralKnowledgeFallback } = input;
  const system = groundingPromptFor(verdict);
  const baseUser = buildUserPrompt({ question, contextText, history, allowGeneralKnowledgeFallback });

  const first = await completeAnswer(deps, system, baseUser);
  let answerText = first.answer;
  let validation = validateCitations(answerText, evidence);
  let regenerated = false;
  let fabricatedIds: string[] = [];

  if (validation.invalidIds.length > 0) {
    regenerated = true;
    const correctiveUser = buildCorrectiveUserPrompt(baseUser, validation.validIds, validation.invalidIds);
    const second = await completeAnswer(deps, system, correctiveUser);
    answerText = second.answer;
    validation = validateCitations(answerText, evidence);

    // Step 4: still invalid after the one regeneration attempt -> strip and
    // record for the caller to log `citation.fabricated` (spec §14.1, §20).
    if (validation.invalidIds.length > 0) {
      fabricatedIds = validation.invalidIds;
      answerText = stripInvalidMarkers(answerText, validation.invalidIds);
      validation = { validIds: validation.validIds, invalidIds: [] };
    }
  }

  let groundingStatus = STATUS_BY_VERDICT[verdict];
  // Step 4's recompute (fabrication stripped down to zero citations) and the
  // separate step-6 guard (a confident `sufficient` answer with zero
  // citations) both land on the same downgrade.
  if (validation.validIds.length === 0 && (fabricatedIds.length > 0 || verdict === 'sufficient')) {
    groundingStatus = 'general_knowledge';
  }

  return {
    answer: answerText,
    groundingStatus,
    sources: toSources(validation.validIds, evidence),
    citedSourceIds: validation.validIds,
    regenerated,
    fabricatedIds,
  };
}
