import type { FusedChunk } from '../fusion/rrf';

/**
 * fuseRRF already keys by chunkId, so this is a near-no-op in practice — but
 * the "exact chunk IDs only, nothing else" rule (spec §12.1) needs a named,
 * testable step or a future contributor could "helpfully" bolt adjacency
 * filtering, per-class caps, or semantic dedup onto it. Do not add any of
 * that here; five adjacent chunks ranked highly must all survive.
 */
export function dedupeExactChunkIds(fused: FusedChunk[]): FusedChunk[] {
  const seen = new Set<string>();
  const result: FusedChunk[] = [];

  for (const chunk of fused) {
    if (seen.has(chunk.chunkId)) continue;
    seen.add(chunk.chunkId);
    result.push(chunk);
  }

  return result;
}
