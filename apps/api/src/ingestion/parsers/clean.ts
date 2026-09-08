const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * A voice span carries the speaker: `<v Rahul>text</v>`. Every other angle
 * bracket construct in a caption file — `<b>`, `<i>`, `<c.yellow>`, and the
 * `<00:05:01.000>` word timings VTT uses for karaoke highlighting — is
 * presentation and is dropped.
 */
const VOICE_TAG = /<v\.?[^\s>]*\s+([^>]+)>/i;
const ANY_TAG = /<[^>]*>/g;

/**
 * A speaker prefix is at most three capitalized words before a colon. The
 * bound matters: without it, "So here is the thing: cosine similarity..."
 * would lose its first clause to a phantom speaker.
 */
const SPEAKER_PREFIX = /^([A-Z][\p{L}\p{N}.'’-]*(?:[ \t][A-Z][\p{L}\p{N}.'’-]*){0,2}):[ \t]+/u;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[lower] ?? match;
  });
}

export interface CleanedCue {
  text: string;
  speaker: string | null;
}

/**
 * Order is load-bearing. Tags are stripped before entities are decoded so a
 * literal `&lt;b&gt;` in the transcript survives as visible text instead of
 * being turned into markup and then deleted.
 */
export function cleanCueText(lines: string[]): CleanedCue {
  const raw = lines.join(' ');

  const voice = VOICE_TAG.exec(raw);
  let speaker = voice?.[1]?.trim() ?? null;

  let text = decodeEntities(raw.replace(ANY_TAG, ' '));
  text = text.replace(/\s+/g, ' ').trim();

  if (speaker === null) {
    const prefix = SPEAKER_PREFIX.exec(text);
    if (prefix?.[1]) {
      speaker = prefix[1];
      text = text.slice(prefix[0].length).trim();
    }
  }

  return { text, speaker: speaker === null || speaker.length === 0 ? null : speaker };
}

/**
 * Splits a caption file into blank-line-separated blocks of non-empty lines.
 * Handles CRLF, a leading BOM, and runs of blank lines, none of which are
 * unusual in files exported by transcription tools.
 */
export function splitBlocks(content: string): string[][] {
  const normalized = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of normalized.split('\n')) {
    if (line.trim().length === 0) {
      if (current.length > 0) blocks.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current);

  return blocks;
}
