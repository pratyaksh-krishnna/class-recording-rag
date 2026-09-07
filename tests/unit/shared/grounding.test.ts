import { test, expect, describe } from 'bun:test';
import { GROUNDING_STATUSES, isGroundingStatus } from '../../../packages/shared/src/grounding';

describe('grounding status', () => {
  test('exposes exactly the four statuses from the spec', () => {
    expect([...GROUNDING_STATUSES]).toEqual([
      'course_grounded',
      'partially_grounded',
      'general_knowledge',
      'conflicting',
    ]);
  });

  test('accepts every valid status', () => {
    for (const status of GROUNDING_STATUSES) {
      expect(isGroundingStatus(status)).toBe(true);
    }
  });

  test('rejects unknown strings and non-strings', () => {
    expect(isGroundingStatus('course-grounded')).toBe(false);
    expect(isGroundingStatus('')).toBe(false);
    expect(isGroundingStatus(null)).toBe(false);
    expect(isGroundingStatus(undefined)).toBe(false);
    expect(isGroundingStatus(42)).toBe(false);
    expect(isGroundingStatus({ status: 'course_grounded' })).toBe(false);
  });

  test('keeps numeric confidence out of the contract entirely', async () => {
    // Spec §23: a similarity score is not a calibrated probability, so no
    // confidence field may ever appear in the response contract.
    const text = await Bun.file(
      new URL('../../../packages/shared/src/contracts.ts', import.meta.url),
    ).text();
    expect(text).not.toContain('confidence');
  });
});
