import { ArrowCounterClockwise, WarningCircle } from '@phosphor-icons/react';
import type { ReactElement } from 'react';
import type { Turn } from '../hooks/useChat';
import { AnswerWithCitations } from './AnswerWithCitations';
import { evidenceElementId } from './EvidenceEntry';
import { EvidenceRail } from './EvidenceRail';
import { GroundingBadge } from './GroundingBadge';
import { PipelineProgress } from './PipelineProgress';

interface MessageTurnProps {
  question: Extract<Turn, { kind: 'question' }>;
  follow: Extract<Turn, { kind: 'answer' | 'pending' | 'error' }> | null;
  animate: boolean;
  onRetry: () => void;
}

function revealEvidence(turnId: string, sourceId: string): void {
  const el = document.getElementById(evidenceElementId(turnId, sourceId));
  if (!(el instanceof HTMLElement)) {
    return;
  }

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({
    behavior: reduceMotion ? 'auto' : 'smooth',
    block: 'nearest',
    inline: 'center',
  });
  el.focus({ preventScroll: true });
  el.classList.remove('evidence-flash');
  void el.offsetWidth;
  el.classList.add('evidence-flash');
  window.setTimeout(() => {
    el.classList.remove('evidence-flash');
  }, 1_200);
}

export function MessageTurn({
  question,
  follow,
  animate,
  onRetry,
}: MessageTurnProps): ReactElement {
  return (
    <article className="min-w-0 border-b border-rule/70 pb-12 last:border-b-0 last:pb-4 md:pb-16">
      <h2 className="max-w-[34ch] break-words font-ui text-[clamp(1.35rem,3vw,2rem)] font-semibold leading-[1.22] tracking-[-0.025em] text-ink text-pretty">
        {question.text}
      </h2>
      {follow ? (
        <div className="mt-7 min-w-0 space-y-6">
          {follow.kind === 'answer' ? (
            <EvidenceRail
              turnId={follow.id}
              sources={follow.response.sources}
              emphasize={follow.response.groundingStatus === 'conflicting'}
            />
          ) : null}
          <FollowBody follow={follow} animate={animate} onRetry={onRetry} />
        </div>
      ) : null}
    </article>
  );
}

function FollowBody({
  follow,
  animate,
  onRetry,
}: {
  follow: Extract<Turn, { kind: 'answer' | 'pending' | 'error' }>;
  animate: boolean;
  onRetry: () => void;
}): ReactElement {
  if (follow.kind === 'pending') {
    return <PipelineProgress startedAt={follow.startedAt} />;
  }

  if (follow.kind === 'error') {
    return (
      <div role="alert" className="max-w-[42rem] rounded-[1.15rem] bg-ground/40 p-1.5 ring-1 ring-ink/[0.06]">
        <div className="rounded-[0.8rem] bg-page px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]">
          <div className="flex items-start gap-3">
            <WarningCircle
              size={20}
              weight="light"
              className="mt-0.5 shrink-0 text-g-conflict"
              aria-hidden="true"
            />
            <p className="min-w-0 break-words font-ui text-sm leading-relaxed text-ink">
              {follow.message}
            </p>
          </div>
          <button
            type="button"
            onClick={onRetry}
            className="group mt-4 inline-flex items-center gap-2 rounded-full bg-ink px-4 py-2 font-ui text-xs font-semibold text-page transition-[transform,background-color] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-mark active:scale-[0.98]"
          >
            <ArrowCounterClockwise
              size={15}
              weight="light"
              className="transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:-rotate-45"
              aria-hidden="true"
            />
            {follow.retry ?? 'Try Again'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`min-w-0${animate ? ' answer-fade' : ''}`}>
      <GroundingBadge status={follow.response.groundingStatus} />
      {follow.response.groundingStatus === 'general_knowledge' ? (
        <p className="mb-3 max-w-[66ch] font-ui text-xs leading-relaxed text-g-general">
          The recordings don&apos;t cover this.
        </p>
      ) : null}
      {follow.response.answer.trim().length === 0 ? (
        <p className="max-w-[66ch] font-reading text-base leading-[1.7] text-ink">
          The answer came back empty. Ask again, or rephrase the question.
        </p>
      ) : (
        <AnswerWithCitations
          answerText={follow.response.answer}
          sources={follow.response.sources}
          turnId={follow.id}
          onCitationActivate={(sourceId) => revealEvidence(follow.id, sourceId)}
        />
      )}
    </div>
  );
}
