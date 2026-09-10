import { StackSimple } from '@phosphor-icons/react';
import type { Source } from '@rag/shared';
import { useCallback, useState, type ReactElement } from 'react';
import { EvidenceEntry } from './EvidenceEntry';
import { SourceViewer } from './SourceViewer';

interface EvidenceRailProps {
  turnId: string;
  sources: Source[];
  emphasize?: boolean;
}

export function EvidenceRail({
  turnId,
  sources,
  emphasize = false,
}: EvidenceRailProps): ReactElement | null {
  const [selectedSource, setSelectedSource] = useState<Source | null>(null);
  const closeViewer = useCallback(() => setSelectedSource(null), []);

  if (sources.length === 0) {
    return null;
  }

  const headingId = `evidence-heading-${turnId}`;

  return (
    <aside
      aria-labelledby={headingId}
      className="min-w-0"
    >
      <div className="mb-2.5 flex items-center justify-between gap-4 px-0.5">
        <h3
          id={headingId}
          className="flex items-center gap-2 font-ui text-xs font-semibold text-ink text-pretty"
        >
          <StackSimple size={16} weight="light" className="text-graphite" aria-hidden="true" />
          Sources
        </h3>
        <p className="font-ui text-[0.7rem] tabular-nums text-graphite" aria-hidden="true">
          {sources.length} {sources.length === 1 ? 'recording' : 'recordings'}
        </p>
      </div>
      <div
        tabIndex={0}
        aria-label="Retrieved recording sources. Scroll horizontally to view more."
        className="-mx-1 flex snap-x snap-proximity items-stretch gap-3 overflow-x-auto overscroll-x-contain px-1 pb-3 pt-1 [scrollbar-color:var(--color-rule)_transparent] [scrollbar-width:thin]"
      >
        {sources.map((source) => (
          <EvidenceEntry
            key={`${source.id}-${source.chunkId}`}
            turnId={turnId}
            source={source}
            emphasize={emphasize}
            onOpen={setSelectedSource}
          />
        ))}
      </div>
      <SourceViewer
        turnId={turnId}
        source={selectedSource}
        onClose={closeViewer}
      />
    </aside>
  );
}
