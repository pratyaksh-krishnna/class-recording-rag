import { cleanCueText, splitBlocks } from './clean';
import { TranscriptParseError } from './errors';
import type { NormalizedCue } from './types';

/** `HH:MM:SS,mmm --> HH:MM:SS,mmm`. A dot in place of the comma is tolerated. */
const TIMING =
  /^(\d{1,2}):([0-5]\d):([0-5]\d)[,.](\d{1,3})\s*-->\s*(\d{1,2}):([0-5]\d):([0-5]\d)[,.](\d{1,3})/;

function toMs(h: string, m: string, s: string, ms: string): number {
  return (
    Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + Number(ms.padEnd(3, '0'))
  );
}

export function parseSrt(content: string): NormalizedCue[] {
  const cues: NormalizedCue[] = [];

  for (const block of splitBlocks(content)) {
    // The numeric counter is optional in practice; skip it when present.
    const first = block[0];
    if (first === undefined) continue;
    const body = TIMING.test(first) ? block : block.slice(1);

    const timingLine = body[0];
    const match = timingLine === undefined ? null : TIMING.exec(timingLine);
    if (match === null) {
      throw new TranscriptParseError(
        `SRT cue ${cues.length + 1} has no valid "HH:MM:SS,mmm --> HH:MM:SS,mmm" timing line.`,
      );
    }

    const [, h1 = '', m1 = '', s1 = '', ms1 = '', h2 = '', m2 = '', s2 = '', ms2 = ''] = match;

    const startMs = toMs(h1, m1, s1, ms1);
    const endMs = toMs(h2, m2, s2, ms2);
    if (endMs < startMs) {
      throw new TranscriptParseError(
        `SRT cue ${cues.length + 1} ends before it starts (${startMs}ms → ${endMs}ms).`,
      );
    }

    const { text, speaker } = cleanCueText(body.slice(1));
    if (text.length === 0) continue;

    cues.push({ index: cues.length, startMs, endMs, text, speaker });
  }

  return cues;
}
