import type { Source } from '@rag/shared';

export type GeneralHeading = 'General knowledge:' | 'Closest course discussion:';

export type Segment =
  | { kind: 'text'; paragraphs: string[] }
  | { kind: 'citation'; sourceId: string; source: Source }
  | { kind: 'general'; heading: GeneralHeading; segments: Segment[] };

const SOURCE_MARKER = /\[SOURCE_(\d+)\]/g;

const GENERAL_HEADINGS: readonly GeneralHeading[] = [
  'General knowledge:',
  'Closest course discussion:',
];

function isGeneralHeading(line: string): GeneralHeading | null {
  const trimmed = line.trim();
  for (const heading of GENERAL_HEADINGS) {
    if (trimmed === heading) {
      return heading;
    }
  }
  return null;
}

function textToParagraphs(text: string): string[] {
  return text
    .split(/\n\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function pushBlockText(segments: Segment[], text: string): void {
  const paragraphs = textToParagraphs(text);
  if (paragraphs.length > 0) {
    segments.push({ kind: 'text', paragraphs });
  }
}

/** Inline fragments preserve whitespace — citation pills sit mid-sentence. */
function pushInlineText(segments: Segment[], text: string): void {
  if (text.length > 0) {
    segments.push({ kind: 'text', paragraphs: [text] });
  }
}

function coalesceTextSegments(segments: Segment[]): Segment[] {
  const merged: Segment[] = [];

  for (const segment of segments) {
    const previous = merged.at(-1);
    if (segment.kind === 'text' && previous?.kind === 'text') {
      const lastIndex = previous.paragraphs.length - 1;
      const first = segment.paragraphs[0];
      if (lastIndex >= 0 && first !== undefined) {
        previous.paragraphs[lastIndex] = previous.paragraphs[lastIndex] + first;
        previous.paragraphs.push(...segment.paragraphs.slice(1));
      } else {
        previous.paragraphs.push(...segment.paragraphs);
      }
    } else {
      merged.push(segment);
    }
  }

  return merged;
}

/**
 * Splits inline text on `[SOURCE_N]` markers (plan §B.3). Unresolvable markers
 * render as plain text — belt-and-braces after backend citation validation.
 */
function parseInline(text: string, sourceById: ReadonlyMap<string, Source>): Segment[] {
  if (!/\[SOURCE_\d+\]/.test(text)) {
    const segments: Segment[] = [];
    pushBlockText(segments, text);
    return segments;
  }

  const segments: Segment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(SOURCE_MARKER)) {
    const index = match.index ?? 0;

    if (index > lastIndex) {
      pushInlineText(segments, text.slice(lastIndex, index));
    }

    const sourceId = `SOURCE_${match[1]}`;
    const source = sourceById.get(sourceId);
    if (source) {
      segments.push({ kind: 'citation', sourceId, source });
    } else {
      pushInlineText(segments, match[0]);
    }

    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    pushInlineText(segments, text.slice(lastIndex));
  }

  return coalesceTextSegments(segments);
}

type TextBlock =
  | { kind: 'plain'; content: string }
  | { kind: 'general'; heading: GeneralHeading; content: string };

/** Splits answer text on general-knowledge headings at line boundaries. */
function splitOnGeneralHeadings(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const lines = text.split('\n');
  let plainLines: string[] = [];
  let currentGeneral: { heading: GeneralHeading; lines: string[] } | null = null;

  const flushPlain = (): void => {
    if (plainLines.length > 0) {
      blocks.push({ kind: 'plain', content: plainLines.join('\n') });
      plainLines = [];
    }
  };

  const flushGeneral = (): void => {
    if (currentGeneral) {
      blocks.push({
        kind: 'general',
        heading: currentGeneral.heading,
        content: currentGeneral.lines.join('\n'),
      });
      currentGeneral = null;
    }
  };

  for (const line of lines) {
    const heading = isGeneralHeading(line);
    if (heading) {
      flushPlain();
      flushGeneral();
      currentGeneral = { heading, lines: [] };
      continue;
    }

    if (currentGeneral) {
      currentGeneral.lines.push(line);
    } else {
      plainLines.push(line);
    }
  }

  flushPlain();
  flushGeneral();

  return blocks;
}

/** Parses an answer string into renderable segments (plan §B.3). Never throws. */
export function parseAnswer(text: string, sources: Source[]): Segment[] {
  if (text.length === 0) {
    return [];
  }

  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const segments: Segment[] = [];

  for (const block of splitOnGeneralHeadings(text)) {
    if (block.kind === 'general') {
      segments.push({
        kind: 'general',
        heading: block.heading,
        segments: parseInline(block.content, sourceById),
      });
    } else {
      segments.push(...parseInline(block.content, sourceById));
    }
  }

  return segments;
}
