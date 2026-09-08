import { test, expect, describe } from 'bun:test';
import { createRuleBasedSegmenter } from '../../../apps/api/src/ingestion/sentences/ruleBased.segmenter';

const segmenter = createRuleBasedSegmenter();
const texts = (input: string) => segmenter.segment(input).map((sentence) => sentence.text);

describe('rule-based sentence segmentation', () => {
  test('splits on terminal punctuation followed by a capital', () => {
    expect(texts('This is one. This is two! Is this three?')).toEqual([
      'This is one.',
      'This is two!',
      'Is this three?',
    ]);
  });

  test('reports character ranges that slice back to the sentence text', () => {
    const input = 'First sentence here. Second sentence here.';
    for (const sentence of segmenter.segment(input)) {
      expect(input.slice(sentence.startChar, sentence.endChar)).toBe(sentence.text);
    }
  });

  test('does not split after a known abbreviation', () => {
    expect(texts('We use vectors, e.g. embeddings, for search. That is the idea.')).toEqual([
      'We use vectors, e.g. embeddings, for search.',
      'That is the idea.',
    ]);
    expect(texts('Ask Dr. Rao about the syllabus first.')).toHaveLength(1);
  });

  test('does not split inside a decimal or a version number', () => {
    expect(texts('The threshold is 3.5 for this run.')).toHaveLength(1);
    expect(texts('We are on v4.2 of the API now.')).toHaveLength(1);
  });

  test('keeps a percentage in its sentence', () => {
    expect(texts('Recall went up 100%. That is the headline.')).toEqual([
      'Recall went up 100%.',
      'That is the headline.',
    ]);
  });

  test('does not split an ellipsis followed by a lowercase continuation', () => {
    expect(texts('So the vector... the vector is normalized first.')).toHaveLength(1);
  });

  test('does not split when the next character is lowercase', () => {
    expect(texts('We index the text. then we embed it.')).toHaveLength(1);
  });

  test('keeps a list of short clauses as one sentence', () => {
    expect(texts('x axis, y axis, z axis all move together.')).toHaveLength(1);
  });

  test('does not split on initials below the character floor', () => {
    expect(texts('A. B. C. are the three cases we care about.')).toHaveLength(1);
  });

  test('caps an unpunctuated run at a clause boundary instead of emitting one blob', () => {
    const short = createRuleBasedSegmenter({ maxSentenceChars: 40 });
    const input =
      'so we take the vector and we normalize it, then we compare it with cosine similarity, and that is all';
    const sentences = short.segment(input);
    expect(sentences.length).toBeGreaterThan(1);
    for (const sentence of sentences) {
      expect(sentence.text.length).toBeLessThanOrEqual(40);
    }
    expect(sentences.map((sentence) => sentence.text).join(' ')).toBe(input);
  });

  test('emits nothing for empty or whitespace-only input', () => {
    expect(segmenter.segment('')).toEqual([]);
    expect(segmenter.segment('   \n  ')).toEqual([]);
  });

  test('emits a final sentence that has no terminal punctuation', () => {
    expect(texts('This one ends. And this one just stops')).toEqual([
      'This one ends.',
      'And this one just stops',
    ]);
  });
});
