import type { Source } from '@rag/shared';
import type { ReactElement } from 'react';
import { EvidenceEntry } from './EvidenceEntry';

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
  if (sources.length === 0) {
    return null;
  }

  const headingId = `evidence-heading-${turnId}`;

  return (
    <aside
      aria-labelledby={headingId}
      className="min-w-0 split:sticky split:top-20 split:max-h-[calc(100dvh-8rem)] split:overflow-y-auto"
    >
      <h3
        id={headingId}
        className="font-ui text-xs font-medium text-graphite text-pretty"
      >
        Evidence
      </h3>
      <div>
        {sources.map((source, index) => (
          <div
            key={`${source.id}-${source.chunkId}`}
            className={index < sources.length - 1 ? 'border-b border-rule' : undefined}
          >
            <EvidenceEntry turnId={turnId} source={source} emphasize={emphasize} />
          </div>
        ))}
      </div>
    </aside>
  );
}
