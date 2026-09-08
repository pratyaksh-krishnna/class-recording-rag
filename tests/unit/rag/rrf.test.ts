import { test, expect, describe } from 'bun:test';
import { fuseRRF, type RankedList } from '../../../apps/api/src/rag/fusion/rrf';

describe('fuseRRF', () => {
  test('scores a rank-1 hit in two lists as 2/(k+1)', () => {
    const lists: RankedList[] = [
      { id: 'q1:vector', queryLabel: 'contextualized', retriever: 'vector', chunkIds: ['a'] },
      { id: 'q1:keyword', queryLabel: 'contextualized', retriever: 'keyword', chunkIds: ['a'] },
    ];

    const [fused] = fuseRRF(lists, 60);

    expect(fused).toBeDefined();
    expect(fused!.chunkId).toBe('a');
    expect(fused!.rrfScore).toBeCloseTo(2 / 61, 12);
  });

  test('honours k: a different k changes scores and can change order', () => {
    // 'a' ranked 1 in one list; 'b' ranked 1 and 2 across two lists.
    const lists: RankedList[] = [
      { id: 'l1', queryLabel: 'l1', retriever: 'vector', chunkIds: ['a', 'b'] },
      { id: 'l2', queryLabel: 'l2', retriever: 'keyword', chunkIds: ['b'] },
    ];

    // k=60: a (rank 1 in l1) = 1/61; b (rank 2 in l1, rank 1 in l2) = 1/62 + 1/61 → b first.
    const highK = fuseRRF(lists, 60);
    expect(highK[0]!.chunkId).toBe('b');
    expect(highK[0]!.rrfScore).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(highK[1]!.rrfScore).toBeCloseTo(1 / 61, 12);

    // k=0: a = 1/1 = 1; b = 1/2 + 1/1 = 1.5 → b still first, but scores differ.
    const lowK = fuseRRF(lists, 0);
    expect(lowK[0]!.chunkId).toBe('b');
    expect(lowK[0]!.rrfScore).toBeCloseTo(1.5, 12);
    expect(lowK[1]!.rrfScore).toBeCloseTo(1, 12);

    expect(highK[0]!.rrfScore).not.toBeCloseTo(lowK[0]!.rrfScore, 6);
  });

  test('rank starts at 1, not 0', () => {
    const lists: RankedList[] = [
      { id: 'l1', queryLabel: 'l1', retriever: 'vector', chunkIds: ['a'] },
    ];

    const [fused] = fuseRRF(lists, 60);

    // If rank started at 0 this would be 1/60, not 1/61.
    expect(fused!.rrfScore).toBeCloseTo(1 / 61, 12);
    expect(fused!.bestRank).toBe(1);
  });

  test('a chunk appearing in multiple lists sums contributions and records all of them', () => {
    const lists: RankedList[] = [
      { id: 'q1:vector', queryLabel: 'q1', retriever: 'vector', chunkIds: ['x', 'a'] },
      { id: 'q1:keyword', queryLabel: 'q1', retriever: 'keyword', chunkIds: ['a', 'x'] },
      { id: 'q2:vector', queryLabel: 'q2', retriever: 'vector', chunkIds: ['a'] },
    ];

    const fused = fuseRRF(lists, 60);
    const a = fused.find((f) => f.chunkId === 'a');

    expect(a).toBeDefined();
    expect(a!.rrfScore).toBeCloseTo(1 / 62 + 1 / 61 + 1 / 61, 12);
    expect(a!.contributions).toEqual([
      { listId: 'q1:vector', rank: 2 },
      { listId: 'q1:keyword', rank: 1 },
      { listId: 'q2:vector', rank: 1 },
    ]);
  });

  test('empty list array yields an empty result', () => {
    expect(fuseRRF([], 60)).toEqual([]);
  });

  test('lists containing empty chunkIds arrays are ignored, not errors', () => {
    const lists: RankedList[] = [
      { id: 'l1', queryLabel: 'l1', retriever: 'vector', chunkIds: [] },
      { id: 'l2', queryLabel: 'l2', retriever: 'keyword', chunkIds: ['a'] },
    ];

    const fused = fuseRRF(lists, 60);

    expect(fused).toHaveLength(1);
    expect(fused[0]!.chunkId).toBe('a');
  });

  test('deterministic tie-break: identical scores sort by chunkId ascending', () => {
    const lists: RankedList[] = [
      { id: 'l1', queryLabel: 'l1', retriever: 'vector', chunkIds: ['zeta', 'alpha'] },
    ];

    const fused = fuseRRF(lists, 60);

    // Both are unique per-list ranks (1 and 2), so give them equal scores via
    // a second list that reverses the ranking, producing a genuine tie.
    const tiedLists: RankedList[] = [
      { id: 'l1', queryLabel: 'l1', retriever: 'vector', chunkIds: ['zeta', 'alpha'] },
      { id: 'l2', queryLabel: 'l2', retriever: 'keyword', chunkIds: ['alpha', 'zeta'] },
    ];
    const tiedFused = fuseRRF(tiedLists, 60);

    expect(tiedFused[0]!.rrfScore).toBeCloseTo(tiedFused[1]!.rrfScore, 12);
    expect(tiedFused[0]!.chunkId).toBe('alpha');
    expect(tiedFused[1]!.chunkId).toBe('zeta');

    // Sanity: without the tie, natural order still holds (zeta ranked first).
    expect(fused[0]!.chunkId).toBe('zeta');
  });

  test('bestRank is the minimum rank across all contributing lists', () => {
    const lists: RankedList[] = [
      { id: 'l1', queryLabel: 'l1', retriever: 'vector', chunkIds: ['x', 'a'] },
      { id: 'l2', queryLabel: 'l2', retriever: 'keyword', chunkIds: ['b', 'a'] },
      { id: 'l3', queryLabel: 'l3', retriever: 'vector', chunkIds: ['a'] },
    ];

    const fused = fuseRRF(lists, 60);
    const a = fused.find((f) => f.chunkId === 'a');

    expect(a!.bestRank).toBe(1);
  });
});
