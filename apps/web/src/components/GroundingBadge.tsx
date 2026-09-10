import {
  BookOpenText,
  CircleHalf,
  SealCheck,
  WarningDiamond,
  type Icon,
} from '@phosphor-icons/react';
import type { ReactElement } from 'react';
import type { GroundingStatus } from '@rag/shared';
import { getGroundingPresentation } from '../lib/grounding';

const ICON: Record<GroundingStatus, Icon> = {
  course_grounded: SealCheck,
  partially_grounded: CircleHalf,
  general_knowledge: BookOpenText,
  conflicting: WarningDiamond,
};

const LABEL_CLASS: Record<GroundingStatus, string> = {
  course_grounded: 'bg-g-course/[0.08] text-g-course ring-g-course/15',
  partially_grounded: 'bg-g-partial/[0.08] text-g-partial ring-g-partial/15',
  general_knowledge: 'bg-g-general/[0.08] text-g-general ring-g-general/15',
  conflicting: 'bg-g-conflict/[0.08] text-g-conflict ring-g-conflict/15',
};

interface GroundingBadgeProps {
  status: GroundingStatus;
}

export function GroundingBadge({ status }: GroundingBadgeProps): ReactElement {
  const presentation = getGroundingPresentation(status);
  const StatusIcon = ICON[status];

  return (
    <p className="mb-3 flex items-center gap-2 font-ui text-xs">
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold ring-1 ${LABEL_CLASS[status]}`}>
        <StatusIcon size={13} weight="light" aria-hidden="true" />
        {presentation.label}
      </span>
    </p>
  );
}
