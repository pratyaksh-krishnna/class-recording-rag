export interface RankedList {
  id: string; // 'q2:vector' — for diagnostics
  queryLabel: string; // 'step_back' | 'sub_query_1' | ...
  retriever: 'vector' | 'keyword';
  chunkIds: string[]; // rank order; rank = index + 1
}

export interface FusedChunk {
  chunkId: string;
  rrfScore: number;
  bestRank: number;
  contributions: { listId: string; rank: number }[];
}

/**
 * Pure fusion: no I/O, no model, `k` is a required parameter so config is
 * read from `config.rrf.k` in exactly one place elsewhere (spec §11).
 */
export function fuseRRF(lists: RankedList[], k: number): FusedChunk[] {
  const byChunkId = new Map<string, FusedChunk>();

  for (const list of lists) {
    for (let index = 0; index < list.chunkIds.length; index += 1) {
      const chunkId = list.chunkIds[index];
      if (chunkId === undefined) continue;
      const rank = index + 1;

      const existing = byChunkId.get(chunkId);
      if (existing === undefined) {
        byChunkId.set(chunkId, {
          chunkId,
          rrfScore: 1 / (k + rank),
          bestRank: rank,
          contributions: [{ listId: list.id, rank }],
        });
      } else {
        existing.rrfScore += 1 / (k + rank);
        existing.bestRank = Math.min(existing.bestRank, rank);
        existing.contributions.push({ listId: list.id, rank });
      }
    }
  }

  // rrfScore desc, then bestRank asc, then chunkId asc — the last tie-break
  // is what makes output deterministic for identical input (spec §11).
  return [...byChunkId.values()].sort((a, b) => {
    if (a.rrfScore !== b.rrfScore) return b.rrfScore - a.rrfScore;
    if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
    return a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0;
  });
}
