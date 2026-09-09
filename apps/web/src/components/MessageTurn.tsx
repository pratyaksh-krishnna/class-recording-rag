import type { ReactElement } from 'react';
import type { Turn } from '../hooks/useChat';
import { AnswerWithCitations } from './AnswerWithCitations';
import { evidenceElementId } from './EvidenceEntry';
import { EvidenceRail } from './EvidenceRail';
import { GroundingBadge } from './GroundingBadge';
import { getGroundingPresentation } from '../lib/grounding';
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
  el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
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
    <article className="min-w-0">
      <h2 className="max-w-[66ch] break-words font-reading text-xl leading-snug text-ink text-pretty">
        {question.text}
      </h2>
      {follow ? (
        <div className="mt-6 grid grid-cols-1 gap-8 split:grid-cols-[minmax(0,1fr)_minmax(var(--spacing-rail-min),var(--spacing-rail-max))] split:gap-[var(--spacing-gap)]">
          <FollowBody follow={follow} animate={animate} onRetry={onRetry} />
          {follow.kind === 'answer' ? (
            <EvidenceRail
              turnId={follow.id}
              sources={follow.response.sources}
              emphasize={follow.response.groundingStatus === 'conflicting'}
            />
          ) : null}
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
    return (
      <div className="flex min-w-0 gap-4">
        <div className="w-[3px] shrink-0 self-stretch bg-rule" aria-hidden="true" />
        <PipelineProgress startedAt={follow.startedAt} />
      </div>
    );
  }

  if (follow.kind === 'error') {
    return (
      <div className="flex min-w-0 gap-4">
        <div className="w-[3px] shrink-0 self-stretch bg-rule" aria-hidden="true" />
        <div role="alert" className="min-w-0 max-w-[66ch]">
          <p className="break-words font-ui text-sm text-ink">{follow.message}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 rounded-[3px] bg-mark px-3 py-2 font-ui text-sm font-medium text-page transition-[background-color,color,filter] duration-[120ms] hover:brightness-[0.92] active:brightness-[0.85]"
          >
            {follow.retry ?? 'Try Again'}
          </button>
        </div>
      </div>
    );
  }

  const presentation = getGroundingPresentation(follow.response.groundingStatus);

  return (
    <div className="flex min-w-0 gap-4">
      <div
        className={`w-[3px] shrink-0 self-stretch ${presentation.ruleClass}${animate ? ' rule-animate' : ''}`}
        aria-hidden="true"
      />
      <div className={`min-w-0 flex-1${animate ? ' answer-fade' : ''}`}>
        <GroundingBadge status={follow.response.groundingStatus} />
        {follow.response.groundingStatus === 'general_knowledge' ? (
          <p className="mb-3 font-ui text-sm text-g-general">The recordings don't cover this.</p>
        ) : null}
        {follow.response.answer.trim().length === 0 ? (
          <p className="max-w-[66ch] font-reading text-base leading-[1.62] text-ink">
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
    </div>
  );
}
