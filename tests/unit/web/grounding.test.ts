import { test, expect, describe } from 'bun:test';
import {
  ALL_GROUNDING_STATUSES,
  getGroundingPresentation,
} from '../../../apps/web/src/lib/grounding';

describe('getGroundingPresentation', () => {
  test('all four statuses return distinct labels and rule classes', () => {
    const presentations = ALL_GROUNDING_STATUSES.map((status) =>
      getGroundingPresentation(status),
    );

    const labels = presentations.map((p) => p.label);
    const ruleClasses = presentations.map((p) => p.ruleClass);

    expect(new Set(labels).size).toBe(4);
    expect(new Set(ruleClasses).size).toBe(4);
  });

  test('course_grounded matches spec §17 label', () => {
    expect(getGroundingPresentation('course_grounded').label).toBe('Course grounded');
    expect(getGroundingPresentation('course_grounded').ruleClass).toBe('rule-course');
  });

  test('partially_grounded matches spec §17 label', () => {
    expect(getGroundingPresentation('partially_grounded').label).toBe('Partly from the course');
    expect(getGroundingPresentation('partially_grounded').ruleClass).toBe('rule-partial');
  });

  test('general_knowledge matches spec §17 label', () => {
    expect(getGroundingPresentation('general_knowledge').label).toBe('Not covered in the course');
    expect(getGroundingPresentation('general_knowledge').ruleClass).toBe('rule-general');
  });

  test('conflicting matches spec §17 label', () => {
    expect(getGroundingPresentation('conflicting').label).toBe('Sources disagree');
    expect(getGroundingPresentation('conflicting').ruleClass).toBe('rule-conflict');
  });
});
