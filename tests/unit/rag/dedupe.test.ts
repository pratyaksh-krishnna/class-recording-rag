import { test, expect, describe } from 'bun:test';
import { dedupeExactChunkIds } from '../../../apps/api/src/rag/context/dedupe';
import type { FusedChunk } from '../../../apps/api/src/rag/fusion/rrf';

function fused(chunkId: string, rrfScore: number, bestRank: number): FusedChunk {
  return { chunkId, rrfScore, bestRank, contributions: [{ listId: 'l1', rank: bestRank }] };
}

describe('dedupeExactChunkIds', () => {
  test('collapses exact duplicate chunkIds, keeping the first (highest-ranked) occurrence', () => {
    const input = [fused('a', 0.5, 1), fused('b', 0.4, 2), fused('a', 0.1, 9)];

    const result = dedupeExactChunkIds(input);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(input[0]);
    expect(result[1]).toEqual(input[1]);
  });

  test('preserves order of the surviving entries', () => {
    const input = [fused('c', 0.9, 1), fused('a', 0.5, 2), fused('c', 0.1, 5), fused('b', 0.2, 6)];

    const result = dedupeExactChunkIds(input);

    expect(result.map((f) => f.chunkId)).toEqual(['c', 'a', 'b']);
  });

  test('retains five adjacent-by-index chunks from the same class — no adjacency filtering', () => {
    const input = ['class-A:10', 'class-A:11', 'class-A:12', 'class-A:13', 'class-A:14'].map(
      (id, i) => fused(id, 1 - i * 0.01, i + 1),
    );

    const result = dedupeExactChunkIds(input);

    expect(result).toHaveLength(5);
    expect(result.map((f) => f.chunkId)).toEqual(input.map((f) => f.chunkId));
  });

  test('empty input yields empty output', () => {
    expect(dedupeExactChunkIds([])).toEqual([]);
  });
});
