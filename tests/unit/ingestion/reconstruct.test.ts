import { test, expect, describe } from 'bun:test';
import { reconstructSentences } from '../../../apps/api/src/ingestion/sentences/reconstruct';
import { createRuleBasedSegmenter } from '../../../apps/api/src/ingestion/sentences/ruleBased.segmenter';
import type { NormalizedCue } from '../../../apps/api/src/ingestion/parsers/types';

const segmenter = createRuleBasedSegmenter();

function cue(index: number, startMs: number, endMs: number, text: string): NormalizedCue {
  return { index, startMs, endMs, text, speaker: null };
}

describe('reconstructSentences', () => {
  test('a sentence spanning three cues takes the first start and the last end', () => {
    const sentences = reconstructSentences(
      [
        cue(0, 1000, 3000, 'So in this lecture we will create'),
        cue(1, 3000, 6000, 'some endpoints and then handle'),
        cue(2, 6000, 9000, 'different HTTP methods. Perfect.'),
      ],
      segmenter,
    );

    expect(sentences[0]).toMatchObject({
      text: 'So in this lecture we will create some endpoints and then handle different HTTP methods.',
      startMs: 1000,
      endMs: 9000,
    });
  });

  test('a sentence entirely inside one cue takes that cue span', () => {
    const sentences = reconstructSentences(
      [cue(0, 5000, 7000, 'This whole thought fits in one cue.'), cue(1, 8000, 9000, 'Next one here.')],
      segmenter,
    );
    expect(sentences[0]).toMatchObject({ startMs: 5000, endMs: 7000 });
  });

  test('a cue containing two sentence ends splits into two sentences sharing that cue', () => {
    const sentences = reconstructSentences(
      [cue(0, 1000, 4000, 'First thought is done. Second thought is also done.')],
      segmenter,
    );
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toMatchObject({ startMs: 1000, endMs: 4000 });
    expect(sentences[1]).toMatchObject({ startMs: 1000, endMs: 4000 });
  });

  test('gapAfterMs is the silence before the next sentence, and zero for the last', () => {
    const sentences = reconstructSentences(
      [
        cue(0, 1000, 3000, 'This is the first thought.'),
        cue(1, 5500, 7000, 'This is the second thought.'),
      ],
      segmenter,
    );
    expect(sentences[0]?.gapAfterMs).toBe(2500);
    expect(sentences[1]?.gapAfterMs).toBe(0);
  });

  test('clamps a negative gap to zero when cues overlap in time', () => {
    const sentences = reconstructSentences(
      [
        cue(0, 1000, 6000, 'This is the first thought.'),
        cue(1, 4000, 8000, 'This is the second thought.'),
      ],
      segmenter,
    );
    expect(sentences[0]?.gapAfterMs).toBe(0);
  });

  test('numbers sentences from zero in reading order', () => {
    const sentences = reconstructSentences(
      [cue(0, 0, 1000, 'One thought here. Two thoughts here. Three thoughts here.')],
      segmenter,
    );
    expect(sentences.map((sentence) => sentence.index)).toEqual([0, 1, 2]);
  });

  test('returns nothing for no cues', () => {
    expect(reconstructSentences([], segmenter)).toEqual([]);
  });
});
