/**
 * The four grounding states the API may return (spec §23).
 * Deliberately no numeric confidence: a similarity score is not a calibrated
 * probability, and presenting one as certainty would mislead.
 */
export const GROUNDING_STATUSES = [
  'course_grounded',
  'partially_grounded',
  'general_knowledge',
  'conflicting',
] as const;

export type GroundingStatus = (typeof GROUNDING_STATUSES)[number];

export function isGroundingStatus(value: unknown): value is GroundingStatus {
  return (
    typeof value === 'string' &&
    (GROUNDING_STATUSES as readonly string[]).includes(value)
  );
}
