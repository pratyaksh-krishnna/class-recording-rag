import type { LLMProvider } from '../../providers/llm/provider';
import type { ReasoningEffort } from '../../config/env.schema';
import type { EvidenceMap } from '../context/contextBuilder';
import { EvidenceAssessmentSchema, type EvidenceAssessment } from '../schemas/index';
import { normalizeAssessment } from '../schemas/normalize';
import { log } from '../../observability/logger';

export interface AssessEvidenceDeps {
  llm: LLMProvider;
  reasoningEffort: ReasoningEffort;
  timeoutMs: number;
}

export interface AssessEvidenceInput {
  question: string;
  contextText: string;
  evidence: EvidenceMap;
}

const SYSTEM_PROMPT = `You are the evidence sufficiency judge for a course-recordings Q&A assistant.

You will be given a user's question and a set of retrieved transcript excerpts, each labelled with a [SOURCE_N] marker. Important: these excerpts were selected by similarity search. A high similarity score means the text is topically related to the question — it does NOT mean the text actually answers the question. Your job is to independently judge sufficiency, not to rubber-stamp retrieval.

Read the question and the excerpts, then decide:
- verdict: "sufficient" if the excerpts fully answer the question; "partial" if they answer part of it or give relevant but incomplete support; "insufficient" if they don't meaningfully address the question; "conflicting" if excerpts disagree with each other about the answer.
- rationale: one or two sentences explaining your verdict. This is for internal logging only and is never shown to a user.
- supportingSourceIds: the [SOURCE_N] ids that support the answer.
- conflictingSourceIds: the [SOURCE_N] ids that conflict with each other or with the supporting evidence.
- missingInformation: up to 5 short phrases naming what's missing, when the verdict is not "sufficient".

Only use [SOURCE_N] ids that literally appear in the excerpts below — never invent one.`;

function buildUserPrompt(question: string, contextText: string): string {
  return `Question: ${question}\n\nRetrieved evidence:\n${contextText}`;
}

/**
 * Conservative fallback (spec §13): non-empty evidence still reaches
 * generation, but only labelled "partial" so anything unsupported must be
 * called out explicitly; empty evidence is "insufficient" outright. The
 * request never fails because the judge did.
 */
function fallbackAssessment(evidence: EvidenceMap): EvidenceAssessment {
  const hasEvidence = evidence.size > 0;
  return {
    verdict: hasEvidence ? 'partial' : 'insufficient',
    rationale: hasEvidence
      ? 'Evidence judge failed; treating retrieved evidence as partial support pending review.'
      : 'Evidence judge failed and no evidence was retrieved.',
    supportingSourceIds: [],
    conflictingSourceIds: [],
    missingInformation: [],
  };
}

/**
 * Independently judges whether the retrieved evidence answers the question
 * (spec §13) — retrieval scores measure similarity, not sufficiency, and a
 * model grading its own answer is not an independent check. Model-produced
 * source ids are never trusted: the result always passes through
 * normalizeAssessment against the real evidence map before use.
 */
export async function assessEvidence(
  deps: AssessEvidenceDeps,
  input: AssessEvidenceInput,
): Promise<EvidenceAssessment> {
  try {
    const result = await deps.llm.complete({
      schemaName: 'evidence_assessment',
      schema: EvidenceAssessmentSchema,
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(input.question, input.contextText),
      reasoningEffort: deps.reasoningEffort,
      timeoutMs: deps.timeoutMs,
    });

    return normalizeAssessment(result.value, new Set(input.evidence.keys()));
  } catch {
    // No error content logged here — it may wrap upstream text (spec §20).
    log().warn({ schemaName: 'evidence_assessment' }, 'evidence judge failed; falling back');
    return fallbackAssessment(input.evidence);
  }
}
