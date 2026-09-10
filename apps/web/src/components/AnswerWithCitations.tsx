import { PlayCircle } from '@phosphor-icons/react';
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
    <div className="max-w-[68ch] break-words font-reading text-base leading-[1.72] text-ink text-pretty">
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
      <p key={`p-${paraKey}`} className={paraKey > 0 ? 'mt-4' : undefined}>
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
      className="group relative -top-px mx-1 inline-flex items-center gap-1 rounded-full bg-mark/[0.08] px-1.5 py-0.5 font-ui text-[0.7rem] font-semibold tabular-nums leading-none text-mark ring-1 ring-mark/15 transition-[transform,background-color,color] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-px hover:bg-mark hover:text-page active:translate-y-0"
    >
      <PlayCircle
        size={12}
        weight="light"
        className="transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:scale-110"
        aria-hidden="true"
      />
      {timecode}
    </button>
  );
}
