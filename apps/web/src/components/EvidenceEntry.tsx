import type { Source } from '@rag/shared';
import type { ReactElement } from 'react';
import { formatTimecode } from '../lib/time';

export function evidenceElementId(turnId: string, sourceId: string): string {
  return `evidence-${turnId}-${sourceId}`;
}

interface EvidenceEntryProps {
  turnId: string;
  source: Source;
  emphasize?: boolean;
}

export function EvidenceEntry({
  turnId,
  source,
  emphasize = false,
}: EvidenceEntryProps): ReactElement {
  const start = formatTimecode(source.startMs);
  const end = formatTimecode(source.endMs);
  const timeClass = emphasize ? 'text-g-conflict' : 'text-graphite';

  return (
    <article
      id={evidenceElementId(turnId, source.id)}
      tabIndex={-1}
      className="grid grid-cols-[5.5rem_1fr] gap-x-4 scroll-mt-20 py-4 min-w-0"
      aria-label={`${source.className}, ${start} to ${end}`}
    >
      <div className={`font-ui text-xs tabular-nums leading-snug ${timeClass}`}>
        <div translate="no">{start}</div>
        <div translate="no">–{end}</div>
      </div>
      <div className="min-w-0">
        {/* Class before module, and the class is the prominent line (plan
            §A.5): a student recognises "Understanding the Gyroscope" long
            before they recognise which module number it sat in. */}
        <p className="break-words font-ui text-xs text-graphite">{source.moduleName}</p>
        <p className="break-words font-ui text-base font-medium leading-snug text-ink">
          {source.className}
        </p>
        {source.excerpt.length > 0 ? (
          <p className="mt-1 line-clamp-3 break-words font-reading text-sm leading-[1.62] text-ink">
            “{source.excerpt}”
          </p>
        ) : null}
      </div>
    </article>
  );
}
