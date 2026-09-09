import type { ReactElement } from 'react';
import type { GroundingStatus } from '@rag/shared';
import { getGroundingPresentation } from '../lib/grounding';

const DOT_CLASS: Record<GroundingStatus, string> = {
  course_grounded: 'bg-g-course',
  partially_grounded: 'bg-g-partial',
  general_knowledge: 'bg-g-general',
  conflicting: 'bg-g-conflict',
};

const LABEL_CLASS: Record<GroundingStatus, string> = {
  course_grounded: 'text-g-course',
  partially_grounded: 'text-g-partial',
  general_knowledge: 'text-g-general',
  conflicting: 'text-g-conflict',
};

interface GroundingBadgeProps {
  status: GroundingStatus;
}

export function GroundingBadge({ status }: GroundingBadgeProps): ReactElement {
  const presentation = getGroundingPresentation(status);

  return (
    <p className="mb-3 flex items-center gap-2 font-ui text-xs">
      <span
        className={`size-1.5 shrink-0 rounded-full ${DOT_CLASS[status]}`}
        aria-hidden="true"
      />
      <span className={`font-medium ${LABEL_CLASS[status]}`}>{presentation.label}</span>
    </p>
  );
}
