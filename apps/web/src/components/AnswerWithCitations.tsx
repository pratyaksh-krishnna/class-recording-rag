import type { Source } from '@rag/shared';
import { type ReactElement, type ReactNode } from 'react';
import { parseAnswer, type Segment } from '../lib/answer';
import { formatTimecode } from '../lib/time';
import { evidenceElementId } from './EvidenceEntry';
import { GeneralKnowledgeBlock } from './GeneralKnowledgeBlock';

interface AnswerWithCitationsProps {
  answerText: string;
  sources: Source[];
  turnId: string;
  onCitationActivate: (sourceId: string) => void;
}

export function AnswerWithCitations({
  answerText,
  sources,
  turnId,
  onCitationActivate,
}: AnswerWithCitationsProps): ReactElement | null {
  const segments = parseAnswer(answerText, sources);

  if (segments.length === 0) {
    return null;
  }

  return (
    <div className="max-w-[66ch] font-reading text-base leading-[1.62] text-pretty text-ink break-words">
      <SegmentFlow
        segments={segments}
        turnId={turnId}
        onCitationActivate={onCitationActivate}
      />
    </div>
  );
}

function SegmentFlow({
  segments,
  turnId,
  onCitationActivate,
}: {
  segments: Segment[];
  turnId: string;
  onCitationActivate: (sourceId: string) => void;
}): ReactElement {
  const nodes: ReactNode[] = [];
  let inline: ReactNode[] = [];
  let paraKey = 0;

  const flush = (): void => {
    if (inline.length === 0) {
      return;
    }
    nodes.push(
      <p key={`p-${paraKey}`} className={paraKey > 0 ? 'mt-3' : undefined}>
        {inline}
      </p>,
    );
    paraKey += 1;
    inline = [];
  };

  for (const [index, segment] of segments.entries()) {
    if (segment.kind === 'general') {
      flush();
      nodes.push(
        <GeneralKnowledgeBlock key={`g-${index}`} heading={segment.heading}>
          <SegmentFlow
            segments={segment.segments}
            turnId={turnId}
            onCitationActivate={onCitationActivate}
          />
        </GeneralKnowledgeBlock>,
      );
      continue;
    }

    if (segment.kind === 'citation') {
      inline.push(
        <CitationButton
          key={`c-${index}-${segment.sourceId}`}
          source={segment.source}
          turnId={turnId}
          onActivate={onCitationActivate}
        />,
      );
      continue;
    }

    for (const [pIndex, paragraph] of segment.paragraphs.entries()) {
      if (pIndex > 0) {
        flush();
      }
      inline.push(
        <span key={`t-${index}-${pIndex}`}>{paragraph}</span>,
      );
    }
  }

  flush();

  return <>{nodes}</>;
}

function CitationButton({
  source,
  turnId,
  onActivate,
}: {
  source: Source;
  turnId: string;
  onActivate: (sourceId: string) => void;
}): ReactElement {
  const timecode = formatTimecode(source.startMs);
  const targetId = evidenceElementId(turnId, source.id);

  return (
    <button
      type="button"
      aria-label={`Evidence from ${source.className} at ${timecode}`}
      aria-controls={targetId}
      translate="no"
      onClick={() => onActivate(source.id)}
      className="mx-0.5 inline font-ui text-xs font-medium tabular-nums text-mark underline decoration-mark underline-offset-2 transition-[color] duration-[120ms] hover:text-ink"
    >
      {timecode}
    </button>
  );
}
