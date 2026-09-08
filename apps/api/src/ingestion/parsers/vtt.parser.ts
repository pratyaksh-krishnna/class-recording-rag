import { cleanCueText, splitBlocks } from './clean';
import { TranscriptParseError } from './errors';
import type { NormalizedCue } from './types';

/** `[HH:]MM:SS.mmm --> [HH:]MM:SS.mmm` followed by optional cue settings. */
const TIMING =
  /^(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)[.,](\d{1,3})\s*-->\s*(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)[.,](\d{1,3})/;

/** Blocks that describe presentation or metadata rather than spoken content. */
const NON_CUE_BLOCK = /^(NOTE|STYLE|REGION)\b/;

function toMs(h: string | undefined, m: string, s: string, ms: string): number {
  return (
    Number(h ?? 0) * 3_600_000 +
    Number(m) * 60_000 +
    Number(s) * 1000 +
    Number(ms.padEnd(3, '0'))
  );
}

export function parseVtt(content: string): NormalizedCue[] {
  const blocks = splitBlocks(content);

  const header = blocks[0]?.[0];
  if (header === undefined || !header.startsWith('WEBVTT')) {
    throw new TranscriptParseError('VTT content does not begin with a WEBVTT header.');
  }

  const cues: NormalizedCue[] = [];

  // blocks[0] is the header block: WEBVTT plus its Kind:/Language: metadata.
  for (const block of blocks.slice(1)) {
    const first = block[0];
    if (first === undefined || NON_CUE_BLOCK.test(first)) continue;

    // The cue identifier line is optional; when present it precedes the timing.
    const body = TIMING.test(first) ? block : block.slice(1);
    const timingLine = body[0];
    const match = timingLine === undefined ? null : TIMING.exec(timingLine);
    // A block that is neither a comment nor a cue is skipped rather than
    // rejected: VTT legitimately carries block kinds this parser does not model.
    if (match === null) continue;

    const [, h1, m1 = '', s1 = '', ms1 = '', h2, m2 = '', s2 = '', ms2 = ''] = match;

    const startMs = toMs(h1, m1, s1, ms1);
    const endMs = toMs(h2, m2, s2, ms2);
    if (endMs < startMs) {
      throw new TranscriptParseError(
        `VTT cue ${cues.length + 1} ends before it starts (${startMs}ms → ${endMs}ms).`,
      );
    }

    const { text, speaker } = cleanCueText(body.slice(1));
    if (text.length === 0) continue;

    cues.push({ index: cues.length, startMs, endMs, text, speaker });
  }

  return cues;
}
