import { Sparkle } from '@phosphor-icons/react';
import { useEffect, useState, type ReactElement } from 'react';

export interface PipelineStage {
  afterMs: number;
  label: string;
}

/** Elapsed-time stages in backend order (plan §B.4). Labels include the ellipsis. */
export const PIPELINE_STAGES: readonly PipelineStage[] = [
  { afterMs: 0, label: 'Reading your question…' },
  { afterMs: 1_400, label: 'Searching the transcripts…' },
  { afterMs: 3_800, label: 'Weighing the evidence…' },
  { afterMs: 6_800, label: 'Writing the answer…' },
];

export function stageIndexForElapsed(elapsedMs: number): number {
  let index = 0;
  for (let i = 0; i < PIPELINE_STAGES.length; i += 1) {
    const stage = PIPELINE_STAGES[i];
    if (stage && elapsedMs >= stage.afterMs) {
      index = i;
    }
  }
  return index;
}

interface PipelineProgressProps {
  startedAt: number;
}

export function PipelineProgress({ startedAt }: PipelineProgressProps): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = (): void => {
      setReduceMotion(media.matches);
    };
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      const nextNow = Date.now();
      const nextIndex = stageIndexForElapsed(Math.max(0, nextNow - startedAt));
      setNow((prevNow) => {
        const prevIndex = stageIndexForElapsed(Math.max(0, prevNow - startedAt));
        return nextIndex === prevIndex ? prevNow : nextNow;
      });
    }, 200);
    return () => window.clearInterval(id);
  }, [startedAt]);

  const index = stageIndexForElapsed(Math.max(0, now - startedAt));
  const stage = PIPELINE_STAGES[index] ?? PIPELINE_STAGES[0];
  const label = stage?.label ?? 'Reading your question…';
  const fill = (index + 1) / PIPELINE_STAGES.length;

  return (
    <div aria-live="polite" aria-atomic="true" className="max-w-[32rem]">
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-mark/[0.08] text-mark ring-1 ring-mark/15">
          <Sparkle
            size={15}
            weight="light"
            aria-hidden="true"
            className="transition-transform duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]"
            style={{ transform: reduceMotion ? undefined : `rotate(${index * 72}deg)` }}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-ui text-xs font-medium text-graphite">{label}</p>
          {reduceMotion ? null : (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-ground" aria-hidden="true">
              <div
                className="h-full origin-left rounded-full bg-mark transition-transform duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]"
                style={{ transform: `scaleX(${fill})` }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
