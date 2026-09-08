import type { EvidenceAssessment, QueryPlan } from './index';

export interface NormalizedQuery {
  label: string;
  text: string;
}

export interface QueryPlanLimits {
  maxQueries: number;
  maxSubQueries: number;
}

const MAX_QUERY_CHARS = 400;

function truncate(text: string): string {
  return text.length > MAX_QUERY_CHARS ? text.slice(0, MAX_QUERY_CHARS) : text;
}

/**
 * Planner output is untrusted input (spec §9): trim; drop empty/whitespace-
 * only; case-insensitively dedupe against the contextualized query and each
 * other; truncate anything over 400 chars; cap subqueries and the total set.
 * The contextualized query is taken from the caller, not `plan.contextualizedQuery`
 * — it is the one value already validated upstream (§8), so it always survives
 * as entry 1 regardless of what the planner echoed back for it.
 */
export function normalizeQueryPlan(
  plan: QueryPlan,
  contextualizedQuery: string,
  limits: QueryPlanLimits,
): NormalizedQuery[] {
  const contextualized = contextualizedQuery.trim();
  const seen = new Set<string>([contextualized.toLowerCase()]);
  const result: NormalizedQuery[] = [{ label: 'contextualized', text: truncate(contextualized) }];

  // sub_query_N numbers surviving subqueries contiguously (1..maxSubQueries),
  // not their original array position — an empty/duplicate slot doesn't burn a number.
  const subQueryCandidates = plan.subQueries.slice(0, limits.maxSubQueries).map((text) => ({ text }));

  const fixedCandidates: { label: string; text: string | null }[] = [
    { label: 'rewritten', text: plan.rewrittenQuery },
    { label: 'step_back', text: plan.stepBackQuery },
  ];

  for (const candidate of fixedCandidates) {
    if (result.length >= limits.maxQueries) break;
    if (candidate.text === null) continue;
    const trimmed = candidate.text.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ label: candidate.label, text: truncate(trimmed) });
  }

  let subQueryCount = 0;
  for (const candidate of subQueryCandidates) {
    if (result.length >= limits.maxQueries) break;
    const trimmed = candidate.text.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    subQueryCount += 1;
    result.push({ label: `sub_query_${subQueryCount}`, text: truncate(trimmed) });
  }

  return result;
}

/**
 * The single-query plan used when planning fails outright (spec §9 step 5),
 * so retrieval always has something to run.
 */
export function fallbackPlan(question: string): NormalizedQuery[] {
  return [{ label: 'contextualized', text: truncate(question.trim()) }];
}

/**
 * Model-produced source IDs are never trusted (spec §13): drop any
 * supporting/conflicting ID absent from the evidence map built from DB rows.
 */
export function normalizeAssessment(
  assessment: EvidenceAssessment,
  validSourceIds: Set<string>,
): EvidenceAssessment {
  return {
    ...assessment,
    supportingSourceIds: assessment.supportingSourceIds.filter((id) => validSourceIds.has(id)),
    conflictingSourceIds: assessment.conflictingSourceIds.filter((id) => validSourceIds.has(id)),
  };
}
