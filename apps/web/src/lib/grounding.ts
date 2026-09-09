import { GROUNDING_STATUSES, type GroundingStatus } from '@rag/shared';

export interface GroundingPresentation {
  label: string;
  ruleClass: string;
  colorVar: string;
  description: string;
}

/** Labels from spec §17 grounding-presentation table; rule classes from plan §A.6. */
const GROUNDING_PRESENTATION: Record<GroundingStatus, GroundingPresentation> = {
  course_grounded: {
    label: 'Course grounded',
    ruleClass: 'rule-course',
    colorVar: '--color-g-course',
    description: 'Answer is grounded in course recordings with cited evidence.',
  },
  partially_grounded: {
    label: 'Partly from the course',
    ruleClass: 'rule-partial',
    colorVar: '--color-g-partial',
    description: 'Answer mixes course evidence with general knowledge.',
  },
  general_knowledge: {
    label: 'Not covered in the course',
    ruleClass: 'rule-general',
    colorVar: '--color-g-general',
    description: 'Recordings do not cover this topic; general knowledge is shown separately.',
  },
  conflicting: {
    label: 'Sources disagree',
    ruleClass: 'rule-conflict',
    colorVar: '--color-g-conflict',
    description: 'Course sources conflict; cited evidence is emphasised.',
  },
};

/** Exhaustive over the union — a new status is a compile error, not a silent fallback. */
export function getGroundingPresentation(status: GroundingStatus): GroundingPresentation {
  return GROUNDING_PRESENTATION[status];
}

/** Exported for tests verifying all four statuses are covered. */
export const ALL_GROUNDING_STATUSES = GROUNDING_STATUSES;
