import { Info } from '@phosphor-icons/react';
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
    <section className="mt-5 rounded-[1.15rem] bg-ground/40 p-1.5 ring-1 ring-ink/[0.05]">
      <div className="rounded-[0.8rem] bg-page/80 px-4 py-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]">
        <div className="mb-2 flex items-center gap-2 text-g-general">
          <Info size={15} weight="light" className="shrink-0" aria-hidden="true" />
          <p className="font-ui text-xs font-semibold text-pretty">{heading}</p>
        </div>
        <div className="min-w-0 text-graphite">{children}</div>
      </div>
    </section>
  );
}
