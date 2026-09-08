import type { NormalizedCue } from '../parsers/types';
import type { SentenceSegmenter } from './segmenter';

/** A sentence with the time span of every cue it touches (spec §5.2). */
export interface ReconstructedSentence {
  index: number;
  text: string;
  startMs: number;
  endMs: number;
  /** Silence until the next sentence starts; zero for the last one. */
  gapAfterMs: number;
}

interface CueRange {
  cue: NormalizedCue;
  startChar: number;
  /** Exclusive. */
  endChar: number;
}

/**
 * Subtitle cues split sentences at arbitrary points, so timing is recovered by
 * concatenating every cue, segmenting the result, and mapping each sentence's
 * character range back onto the cues it overlaps. A sentence that spans three
 * cues therefore carries the first cue's start and the last cue's end.
 */
export function reconstructSentences(
  cues: NormalizedCue[],
  segmenter: SentenceSegmenter,
): ReconstructedSentence[] {
  if (cues.length === 0) return [];

  const ranges: CueRange[] = [];
  const parts: string[] = [];
  let cursor = 0;

  for (const cue of cues) {
    if (cursor > 0) cursor += 1; // the single space joining cues
    ranges.push({ cue, startChar: cursor, endChar: cursor + cue.text.length });
    parts.push(cue.text);
    cursor += cue.text.length;
  }

  const fullText = parts.join(' ');
  const sentences = segmenter.segment(fullText);

  // A single forward sweep: sentences and cues are both ordered, so the first
  // overlapping cue never moves backwards.
  let firstCandidate = 0;
  const reconstructed: ReconstructedSentence[] = [];

  for (const sentence of sentences) {
    while (firstCandidate < ranges.length) {
      const range = ranges[firstCandidate];
      if (range === undefined || range.endChar > sentence.startChar) break;
      firstCandidate += 1;
    }

    let last = firstCandidate;
    while (last + 1 < ranges.length) {
      const next = ranges[last + 1];
      if (next === undefined || next.startChar >= sentence.endChar) break;
      last += 1;
    }

    const first = ranges[firstCandidate] ?? ranges[ranges.length - 1];
    const final = ranges[last] ?? first;
    if (first === undefined || final === undefined) continue;

    reconstructed.push({
      index: reconstructed.length,
      text: sentence.text,
      startMs: first.cue.startMs,
      endMs: final.cue.endMs,
      gapAfterMs: 0,
    });
  }

  for (let i = 0; i < reconstructed.length - 1; i += 1) {
    const current = reconstructed[i];
    const next = reconstructed[i + 1];
    if (current === undefined || next === undefined) continue;
    // Cues can overlap in time, which would make a raw difference negative;
    // a gap is a duration, so it floors at zero.
    current.gapAfterMs = Math.max(0, next.startMs - current.endMs);
  }

  return reconstructed;
}
