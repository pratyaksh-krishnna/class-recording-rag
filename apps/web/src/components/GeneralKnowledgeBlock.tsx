import type { ReactElement, ReactNode } from 'react';
import type { GeneralHeading } from '../lib/answer';

interface GeneralKnowledgeBlockProps {
  heading: GeneralHeading;
  children: ReactNode;
}

export function GeneralKnowledgeBlock({
  heading,
  children,
}: GeneralKnowledgeBlockProps): ReactElement {
  return (
    <section className="tint-general mt-4 flex gap-3 px-3 py-3">
      <div className="rule-general w-[3px] shrink-0 self-stretch" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="mb-2 font-ui text-xs font-medium text-g-general text-pretty">{heading}</p>
        {children}
      </div>
    </section>
  );
}
