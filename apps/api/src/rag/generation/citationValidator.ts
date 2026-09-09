import type { EvidenceMap } from '../context/contextBuilder';

// Matches the exact marker form the prompt asks for and the context builder
// emits ('SOURCE_1' style ids only — no zero padding, no other prefixes).
const CITATION_MARKER_RE = /\[SOURCE_(\d+)\]/g;

/**
 * Every `[SOURCE_N]` marker in the answer PROSE, in first-appearance order,
 * deduped. This is the authoritative citation list (spec §14.1 step 1) — the
 * model's `citedSourceIds` field is only cross-checked against it, never
 * trusted on its own.
 */
export function extractCitationMarkers(answer: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const match of answer.matchAll(CITATION_MARKER_RE)) {
    const digits = match[1];
    if (digits === undefined) continue;
    const id = `SOURCE_${digits}`;
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }

  return ordered;
}

export interface ValidationResult {
  validIds: string[];
  invalidIds: string[];
}

/**
 * Splits the answer's cited markers against the evidence map — the only
 * source of truth for which ids are real (spec §14.1 step 2). Order is
 * preserved from `extractCitationMarkers`, so both lists stay in
 * first-appearance order.
 */
export function validateCitations(answer: string, evidence: EvidenceMap): ValidationResult {
  const validIds: string[] = [];
  const invalidIds: string[] = [];

  for (const id of extractCitationMarkers(answer)) {
    if (evidence.has(id)) {
      validIds.push(id);
    } else {
      invalidIds.push(id);
    }
  }

  return { validIds, invalidIds };
}

/**
 * Removes only the named (invalid) markers, leaving valid ones untouched,
 * then tidies the whitespace and orphaned punctuation the removal leaves
 * behind (spec §14.1 step 4) — mirrors the marker-stripping in
 * conversation/history.ts, but selective by id rather than blanket.
 */
export function stripInvalidMarkers(answer: string, invalidIds: string[]): string {
  if (invalidIds.length === 0) return answer;

  const invalid = new Set(invalidIds);

  return answer
    .replace(/\s*\[SOURCE_(\d+)\]\s*/g, (whole, digits: string) =>
      invalid.has(`SOURCE_${digits}`) ? ' ' : whole,
    )
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
