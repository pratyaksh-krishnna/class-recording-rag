import { ABBREVIATIONS } from './abbreviations';
import {
  DEFAULT_SEGMENTER_OPTIONS,
  type SegmenterOptions,
  type Sentence,
  type SentenceSegmenter,
} from './segmenter';

const TERMINATORS = new Set(['.', '!', '?', '…']);
const OPENING_QUOTES = new Set(['"', "'", '“', '‘', '(', '[']);
/** Where a run that hits the ceiling may be cut, best first. */
const CLAUSE_BREAKS = [';', ',', ':', '—', '–'];

function isSpace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

/** The whitespace-delimited token ending at `end` (exclusive), lowercased. */
function tokenEndingAt(text: string, end: number): string {
  let start = end;
  while (start > 0 && !isSpace(text[start - 1])) start -= 1;
  return text.slice(start, end).toLowerCase();
}

/**
 * Proposes a boundary after every run of terminal punctuation and then rejects
 * it under the rules in spec §5.3. Stated as explicit rejections rather than a
 * regex so each rule is separately readable and separately testable.
 */
function acceptsBoundary(
  text: string,
  sentenceStart: number,
  punctuationStart: number,
  punctuationEnd: number,
  options: SegmenterOptions,
): boolean {
  // The sentence so far must be substantial — guards "A. B. C." and initials.
  if (punctuationEnd - sentenceStart < options.minSentenceChars) return false;

  const punctuation = text.slice(punctuationStart, punctuationEnd);
  const token = tokenEndingAt(text, punctuationEnd);

  // A known abbreviation's period belongs to the word.
  if (ABBREVIATIONS.has(token)) return false;

  // A single initial ("R.") is an abbreviation the list cannot enumerate.
  if (/^\p{L}\.$/u.test(token)) return false;

  let next = punctuationEnd;
  while (isSpace(text[next])) next += 1;
  const nextChar = text[next];

  // End of input: the caller emits the tail, so no boundary is needed here.
  if (nextChar === undefined) return false;

  // A decimal or a version continues rather than ends. "3.5" never reaches here
  // (no whitespace follows the period), so this covers the spaced form "3. 5".
  const previousChar = text[punctuationStart - 1];
  if (
    punctuation === '.' &&
    previousChar !== undefined &&
    /\d/.test(previousChar) &&
    /\d/.test(nextChar)
  ) {
    return false;
  }

  // An ellipsis before a lowercase word is a pause inside one thought.
  if (punctuation.length > 1 || punctuation === '…') {
    if (nextChar.toLowerCase() === nextChar && /\p{L}/u.test(nextChar)) return false;
  }

  // Anything that is not a new beginning is a continuation.
  return /\p{Lu}|\d/u.test(nextChar) || OPENING_QUOTES.has(nextChar);
}

/** Trims the range, then emits it only if something is left. */
function pushRange(text: string, start: number, end: number, out: Sentence[]): void {
  let from = start;
  let to = end;
  while (from < to && isSpace(text[from])) from += 1;
  while (to > from && isSpace(text[to - 1])) to -= 1;
  if (to > from) out.push({ text: text.slice(from, to), startChar: from, endChar: to });
}

/**
 * Splits any range longer than the ceiling at the latest clause break that fits,
 * falling back to the latest space and finally to a hard cut. Applied after
 * punctuation-based segmentation, so it only ever fires on genuinely
 * unpunctuated speech.
 */
function pushCapped(text: string, start: number, end: number, out: Sentence[], max: number): void {
  let from = start;

  while (end - from > max) {
    const window = text.slice(from, from + max);

    let cut = -1;
    for (const mark of CLAUSE_BREAKS) {
      const at = window.lastIndexOf(mark);
      if (at >= 0) cut = Math.max(cut, at + mark.length);
    }
    if (cut <= 0) cut = window.lastIndexOf(' ');
    // No break of any kind inside the window: cut at the ceiling so the loop
    // always advances.
    if (cut <= 0) cut = max;

    pushRange(text, from, from + cut, out);
    from += cut;
  }

  pushRange(text, from, end, out);
}

export function createRuleBasedSegmenter(
  overrides: Partial<SegmenterOptions> = {},
): SentenceSegmenter {
  const options: SegmenterOptions = { ...DEFAULT_SEGMENTER_OPTIONS, ...overrides };

  return {
    segment(text: string): Sentence[] {
      const sentences: Sentence[] = [];
      let sentenceStart = 0;
      let cursor = 0;

      while (cursor < text.length) {
        const char = text[cursor];
        if (char === undefined || !TERMINATORS.has(char)) {
          cursor += 1;
          continue;
        }

        const punctuationStart = cursor;
        while (cursor < text.length) {
          const run = text[cursor];
          if (run === undefined || !TERMINATORS.has(run)) break;
          cursor += 1;
        }

        // A terminator must be followed by whitespace or end of input to end a
        // sentence; "3.5" and "example.com" are excluded here, not by a rule.
        const following = text[cursor];
        if (following !== undefined && !isSpace(following)) continue;

        if (acceptsBoundary(text, sentenceStart, punctuationStart, cursor, options)) {
          pushCapped(text, sentenceStart, cursor, sentences, options.maxSentenceChars);
          sentenceStart = cursor;
        }
      }

      pushCapped(text, sentenceStart, text.length, sentences, options.maxSentenceChars);
      return sentences;
    },
  };
}
