import type { RagConfig } from '../../config/rag';
import type { ReconstructedSentence } from '../sentences/reconstruct';
import type { Tokenizer } from '../tokenizer/tokenizer';
import { buildChunkKey } from './chunkKey';

export type ChunkingConfig = RagConfig['chunking'];

/** Everything the chunk key needs that the sentences themselves do not carry. */
export interface ChunkContext {
  cohortSlug: string;
  moduleSlug: string;
  classSlug: string;
  contentHash: string;
  embeddingModel: string;
}

/** A chunk ready to persist. Field names mirror the `chunks` table. */
export interface PreparedChunk {
  chunkKey: string;
  chunkIndex: number;
  text: string;
  startMs: number;
  endMs: number;
  tokenCount: number;
  sentenceCount: number;
  overlapSentenceCount: number;
  chunkingVersion: string;
  tokenizer: string;
  embeddingModel: string;
}

export interface ChunkingResult {
  chunks: PreparedChunk[];
  stats: {
    sentenceCount: number;
    oversizedSentences: number;
    gapBoundariesUsed: number;
  };
}

interface Measured {
  sentence: ReconstructedSentence;
  tokens: number;
}

/**
 * The documented rule set from spec §6.1, in rule order. Pure and synchronous:
 * no clock, no randomness, no I/O. Identical input yields byte-identical
 * output, which is what lets Phase 3 re-ingest with ON CONFLICT DO NOTHING and
 * change nothing.
 *
 * R1 is structural rather than checked: the function takes the sentences of
 * exactly one transcript, so a chunk spanning two classes is unrepresentable.
 */
export function chunkSentences(
  sentences: ReconstructedSentence[],
  ctx: ChunkContext,
  config: ChunkingConfig,
  tokenizer: Tokenizer,
): ChunkingResult {
  const chunks: PreparedChunk[] = [];
  const stats = { sentenceCount: sentences.length, oversizedSentences: 0, gapBoundariesUsed: 0 };

  let open: Measured[] = [];
  let openTokens = 0;
  let openOverlapCount = 0;
  /** False while `open` holds nothing but sentences already emitted as overlap. */
  let pendingNew = false;

  const emit = (): void => {
    const first = open[0];
    const last = open[open.length - 1];
    if (first === undefined || last === undefined) return;

    const chunkIndex = chunks.length;
    chunks.push({
      chunkKey: buildChunkKey({
        cohortSlug: ctx.cohortSlug,
        moduleSlug: ctx.moduleSlug,
        classSlug: ctx.classSlug,
        contentHash: ctx.contentHash,
        chunkingVersion: config.version,
        embeddingModel: ctx.embeddingModel,
        chunkIndex,
      }),
      chunkIndex,
      text: open.map((item) => item.sentence.text).join(' '),
      // §6.2: the span of the sentences actually included, overlap and all, so
      // consecutive chunks legitimately overlap in time.
      startMs: first.sentence.startMs,
      endMs: last.sentence.endMs,
      // The same measure the rules were enforced against, so a chunk's recorded
      // size always agrees with the boundary decisions that produced it.
      tokenCount: openTokens,
      sentenceCount: open.length,
      overlapSentenceCount: openOverlapCount,
      chunkingVersion: config.version,
      tokenizer: tokenizer.name,
      embeddingModel: ctx.embeddingModel,
    });
  };

  /**
   * R7: seed the next chunk with trailing sentences of the one just closed,
   * within `overlapRatio × previousChunkTokens` and capped at one fewer than
   * the previous sentence count so the next chunk always contains something new.
   */
  const flush = (): void => {
    if (open.length === 0) return;
    emit();

    const budget = config.overlapRatio * openTokens;
    const maxSentences = Math.max(0, open.length - 1);
    const carried: Measured[] = [];
    let carriedTokens = 0;

    for (let i = open.length - 1; i >= 0 && carried.length < maxSentences; i -= 1) {
      const candidate = open[i];
      if (candidate === undefined) break;
      if (carriedTokens + candidate.tokens > budget) break;
      carried.unshift(candidate);
      carriedTokens += candidate.tokens;
    }

    open = carried;
    openTokens = carriedTokens;
    openOverlapCount = carried.length;
    pendingNew = false;
  };

  for (const sentence of sentences) {
    const tokens = tokenizer.count(sentence.text);

    // R3: an oversized sentence is kept whole as its own chunk.
    if (tokens > config.maxTokens) {
      flush();
      // Carried overlap belongs to the previous chunk's tail, not to a sentence
      // that must stand alone; drop it and emit the sentence intact.
      open = [{ sentence, tokens }];
      openTokens = tokens;
      openOverlapCount = 0;
      pendingNew = true;
      stats.oversizedSentences += 1;
      flush();
      continue;
    }

    // R5: flush before overflowing, but only once the chunk is worth flushing.
    if (
      open.length > 0 &&
      openTokens + tokens > config.maxTokens &&
      openTokens >= config.minTokens
    ) {
      flush();
    }

    open.push({ sentence, tokens });
    openTokens += tokens;
    pendingNew = true;

    // R4: a real pause is the preferred boundary — but only past the minimum,
    // which is what keeps an early pause from producing a tiny chunk.
    if (openTokens >= config.minTokens && sentence.gapAfterMs >= config.gapPreferredMs) {
      stats.gapBoundariesUsed += 1;
      flush();
      continue;
    }

    // R6: otherwise close at the target size.
    if (openTokens >= config.targetTokens) flush();
  }

  // R8: the tail is emitted as-is — never merged backwards, never padded. It is
  // skipped when `open` holds only overlap already carried out of the last
  // chunk, which would otherwise duplicate persisted content.
  if (open.length > 0 && pendingNew) emit();

  return { chunks, stats };
}
