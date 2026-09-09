import { test, expect, describe } from 'bun:test';
import { confusionMatrix, mrr, ndcgAtK, recallAtK } from '../../../apps/api/evals/metrics';

describe('recallAtK', () => {
  test('k smaller than relevant set: only first k slots count', () => {
    const retrieved = ['a', 'b', 'c', 'd'];
    const relevant = ['a', 'c', 'e'];

    // k=2 sees 'a' only → 1/3
    expect(recallAtK(retrieved, relevant, 2)).toBeCloseTo(1 / 3, 12);
  });

  test('k equal to relevant set size', () => {
    const retrieved = ['x', 'a', 'b', 'c'];
    const relevant = ['a', 'b'];

    // k=2, top two after dedupe are x,a → 1/2
    expect(recallAtK(retrieved, relevant, 2)).toBeCloseTo(0.5, 12);
  });

  test('k larger than relevant set: extra tail slots do not add hits', () => {
    const retrieved = ['a', 'b', 'c', 'd', 'e'];
    const relevant = ['a', 'b'];

    expect(recallAtK(retrieved, relevant, 10)).toBeCloseTo(1, 12);
  });

  test('empty relevant set returns 0, not 1', () => {
    expect(recallAtK(['a', 'b'], [], 5)).toBe(0);
  });

  test('duplicates in retrieved are deduped before scoring', () => {
    const retrieved = ['a', 'a', 'b', 'b', 'c'];
    const relevant = ['a', 'c'];

    // Without dedupe k=2 would be 1/2 (a,a); with dedupe k=2 is a,b → still 1/2.
    // k=3 after dedupe is a,b,c → 2/2 = 1.
    expect(recallAtK(retrieved, relevant, 3)).toBeCloseTo(1, 12);
    expect(recallAtK(retrieved, relevant, 2)).toBeCloseTo(0.5, 12);
  });
});

describe('mrr', () => {
  test('first hit at rank 1 → MRR = 1', () => {
    expect(mrr(['a', 'b', 'c'], ['a', 'z'])).toBeCloseTo(1, 12);
  });

  test('first hit at rank 3 → MRR = 1/3', () => {
    expect(mrr(['x', 'y', 'a', 'b'], ['a'])).toBeCloseTo(1 / 3, 12);
  });

  test('no relevant item in retrieved → MRR = 0', () => {
    expect(mrr(['x', 'y'], ['a', 'b'])).toBe(0);
  });
});

describe('ndcgAtK', () => {
  test('matches a hand-computed DCG / ideal DCG at k=3', () => {
    const retrieved = ['x', 'a', 'b'];
    const relevant = ['a', 'b', 'c'];
    const k = 3;

    // DCG: rank2 'a' → 1/log2(3); rank3 'b' → 1/log2(4)
    const dcg = 1 / Math.log2(3) + 1 / Math.log2(4);
    const idealDcg = 1 / Math.log2(2) + 1 / Math.log2(3) + 1 / Math.log2(4);

    expect(ndcgAtK(retrieved, relevant, k)).toBeCloseTo(dcg / idealDcg, 12);
  });

  test('perfect ordering of all relevant items yields exactly 1', () => {
    const retrieved = ['a', 'b', 'c', 'x'];
    const relevant = ['a', 'b', 'c'];

    expect(ndcgAtK(retrieved, relevant, 3)).toBeCloseTo(1, 12);
  });

  test('reversed ordering yields less than 1', () => {
    const relevant = ['a', 'b'];
    const perfect = ndcgAtK(['a', 'b', 'x'], relevant, 3);
    const withIrrelevantFirst = ndcgAtK(['x', 'a', 'b'], relevant, 3);

    expect(perfect).toBeCloseTo(1, 12);
    expect(withIrrelevantFirst).toBeLessThan(perfect);
    expect(withIrrelevantFirst).toBeGreaterThan(0);
  });
});

describe('confusionMatrix', () => {
  const labels = ['course_grounded', 'general_knowledge'] as const;

  test('counts land in [expected][predicted]', () => {
    const matrix = confusionMatrix(
      [
        { expected: 'course_grounded', predicted: 'course_grounded' },
        { expected: 'course_grounded', predicted: 'general_knowledge' },
        { expected: 'general_knowledge', predicted: 'general_knowledge' },
      ],
      labels,
    );

    expect(matrix.counts[0]![0]).toBe(1);
    expect(matrix.counts[0]![1]).toBe(1);
    expect(matrix.counts[1]![0]).toBe(0);
    expect(matrix.counts[1]![1]).toBe(1);
  });

  test('accuracy is trace over total counted pairs', () => {
    const matrix = confusionMatrix(
      [
        { expected: 'course_grounded', predicted: 'course_grounded' },
        { expected: 'course_grounded', predicted: 'general_knowledge' },
        { expected: 'general_knowledge', predicted: 'general_knowledge' },
      ],
      labels,
    );

    expect(matrix.accuracy).toBeCloseTo(2 / 3, 12);
  });

  test('an unseen label does not crash and is omitted from totals', () => {
    const matrix = confusionMatrix(
      [
        { expected: 'course_grounded', predicted: 'course_grounded' },
        { expected: 'course_grounded', predicted: 'unknown_label' },
      ],
      labels,
    );

    expect(matrix.counts[0]![0]).toBe(1);
    expect(matrix.accuracy).toBeCloseTo(1, 12);
  });
});
