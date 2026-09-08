/** A sentence and the half-open range it occupies in the text it came from. */
export interface Sentence {
  text: string;
  startChar: number;
  /** Exclusive. `text === input.slice(startChar, endChar)` always holds. */
  endChar: number;
}

export interface SentenceSegmenter {
  segment(text: string): Sentence[];
}

export interface SegmenterOptions {
  /**
   * A candidate boundary is rejected while the sentence so far is shorter than
   * this. Without it, "A. B. C." becomes three sentences and the chunker's
   * per-sentence bookkeeping fills with noise.
   */
  minSentenceChars: number;
  /**
   * A hard ceiling. Transcripts of unpunctuated speech would otherwise produce
   * a single unbounded "sentence" that R3 then turns into one enormous chunk.
   */
  maxSentenceChars: number;
}

export const DEFAULT_SEGMENTER_OPTIONS: SegmenterOptions = {
  minSentenceChars: 12,
  maxSentenceChars: 400,
};
