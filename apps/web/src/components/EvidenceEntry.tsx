import { ArrowUpRight, Clock, VideoCamera } from '@phosphor-icons/react';
import type { Source } from '@rag/shared';
import type { ReactElement } from 'react';
import { formatTimecode } from '../lib/time';

export function evidenceElementId(turnId: string, sourceId: string): string {
  return `evidence-${turnId}-${sourceId}`;
}

export function isSourceOpenKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

interface EvidenceEntryProps {
  turnId: string;
  source: Source;
  emphasize?: boolean;
  onOpen: (source: Source) => void;
}

export function EvidenceEntry({
  turnId,
  source,
  emphasize = false,
  onOpen,
}: EvidenceEntryProps): ReactElement {
  const start = formatTimecode(source.startMs);
  const end = formatTimecode(source.endMs);
  const timeClass = emphasize
    ? 'bg-g-conflict/10 text-g-conflict ring-g-conflict/15'
    : 'bg-ground/70 text-graphite ring-ink/[0.05]';

  return (
    <article
      id={evidenceElementId(turnId, source.id)}
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      className={`group flex h-[12.75rem] w-[min(17.25rem,calc(100vw-3.5rem))] flex-none cursor-pointer snap-start scroll-ml-4 scroll-mt-24 flex-col overflow-hidden rounded-[1.05rem] bg-page px-4 py-3.5 text-left shadow-[0_12px_35px_-28px_rgba(25,29,26,0.45)] ring-1 ${emphasize ? 'ring-g-conflict/20' : 'ring-ink/[0.07]'} transition-[transform,box-shadow] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-0.5 hover:shadow-[0_18px_42px_-26px_rgba(25,29,26,0.35)] focus:ring-2 focus:ring-mark/35 focus:outline-none`}
      aria-label={`Open full chunk from ${source.className}, ${start} to ${end}`}
      onClick={() => onOpen(source)}
      onKeyDown={(event) => {
        if (!isSourceOpenKey(event.key)) return;
        event.preventDefault();
        onOpen(source);
      }}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[0.65rem] bg-ground/60 text-mark ring-1 ring-ink/[0.05] shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]">
          <VideoCamera size={16} weight="light" aria-hidden="true" />
        </span>
        <p className="min-w-0 truncate font-ui text-[0.7rem] font-medium text-graphite">
          {source.moduleName}
        </p>
      </div>

      <p className="mt-3 line-clamp-2 break-words font-ui text-sm font-semibold leading-[1.35] tracking-[-0.01em] text-ink">
        {source.className}
      </p>
      {source.excerpt.length > 0 ? (
        <p className="mt-1.5 line-clamp-3 break-words font-reading text-xs leading-[1.55] text-graphite">
          {source.excerpt}
        </p>
      ) : null}

      <div className="mt-auto flex items-center justify-between gap-3 pt-3">
        <span
          translate="no"
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-ui text-[0.7rem] font-semibold tabular-nums ring-1 ${timeClass}`}
        >
          <Clock size={13} weight="light" aria-hidden="true" />
          {start}–{end}
        </span>
        <span className="flex items-center gap-1 font-ui text-[0.68rem] font-medium text-graphite transition-colors group-hover:text-mark" aria-hidden="true">
          Full chunk
          <ArrowUpRight size={13} weight="light" />
        </span>
      </div>
    </article>
  );
}
