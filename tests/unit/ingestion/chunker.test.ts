import { test, expect, describe } from 'bun:test';
import {
  chunkSentences,
  type ChunkContext,
  type ChunkingConfig,
} from '../../../apps/api/src/ingestion/chunking/chunker';
import type { ReconstructedSentence } from '../../../apps/api/src/ingestion/sentences/reconstruct';
import type { Tokenizer } from '../../../apps/api/src/ingestion/tokenizer/tokenizer';

/**
 * One token per whitespace-delimited word. Deterministic and legible, which
 * lets these tests state exact sizes; the real encoder is proven in its own
 * suite and injected identically.
 */
const wordTokenizer: Tokenizer = {
  name: 'test-words',
  count: (text) => (text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length),
};

const config: ChunkingConfig = {
  version: 'v1',
  targetTokens: 500,
  minTokens: 350,
  maxTokens: 650,
  overlapRatio: 0.125,
  gapPreferredMs: 2000,
  tokenizerEncoding: 'test-words',
};

const ctx: ChunkContext = {
  cohortSlug: 'mobile-dev-cohort',
  moduleSlug: 'module-7',
  classSlug: 'gyroscope',
  contentHash: '9f3a1c7d2e04b5a6',
  embeddingModel: 'text-embedding-3-small',
};

/** A sentence of `tokens` words, uniquely worded so chunk text is traceable. */
function sentence(
  index: number,
  tokens: number,
  options: { gapAfterMs?: number; startMs?: number; endMs?: number } = {},
): ReconstructedSentence {
  const startMs = options.startMs ?? index * 1000;
  return {
    index,
    text: Array.from({ length: tokens }, (_, word) => `s${index}w${word}`).join(' '),
    startMs,
    endMs: options.endMs ?? startMs + 900,
    gapAfterMs: options.gapAfterMs ?? 100,
  };
}

function series(count: number, tokens: number, gapAfterMs = 100): ReconstructedSentence[] {
  return Array.from({ length: count }, (_, index) => sentence(index, tokens, { gapAfterMs }));
}

describe('chunkSentences — sizes and sentence atomicity', () => {
  test('a typical transcript lands inside the 350-650 window', () => {
    const { chunks } = chunkSentences(series(120, 20), ctx, config, wordTokenizer);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.tokenCount).toBeGreaterThanOrEqual(config.minTokens);
      expect(chunk.tokenCount).toBeLessThanOrEqual(config.maxTokens);
    }
  });

  test('no chunk boundary ever falls inside a sentence', () => {
    const sentences = series(120, 20);
    const { chunks } = chunkSentences(sentences, ctx, config, wordTokenizer);
    const known = new Set(sentences.map((item) => item.text));
    for (const chunk of chunks) {
      // Rebuilding the chunk from whole known sentences must consume it exactly.
      let remaining = chunk.text;
      while (remaining.length > 0) {
        const match = [...known].find((text) => remaining.startsWith(text));
        expect(match).toBeDefined();
        remaining = remaining.slice((match ?? '').length).replace(/^ /, '');
      }
    }
  });

  test('R3: a sentence larger than maxTokens becomes its own intact chunk', () => {
    const sentences = [sentence(0, 100), sentence(1, 900), sentence(2, 100)];
    const { chunks, stats } = chunkSentences(sentences, ctx, config, wordTokenizer);
    const giant = chunks.find((chunk) => chunk.tokenCount === 900);
    expect(giant).toBeDefined();
    expect(giant?.sentenceCount).toBe(1);
    expect(giant?.text).toBe(sentences[1]?.text);
    expect(stats.oversizedSentences).toBe(1);
  });

  test('R4: a 2.5s gap past minTokens splits, and the same gap early does not', () => {
    const late = series(40, 10);
    const lateBreak = late[39];
    if (lateBreak === undefined) throw new Error('fixture');
    lateBreak.gapAfterMs = 2500;
    const lateResult = chunkSentences([...late, ...series(20, 10)], ctx, config, wordTokenizer);
    expect(lateResult.stats.gapBoundariesUsed).toBe(1);
    expect(lateResult.chunks[0]?.tokenCount).toBe(400);

    const early = series(60, 10);
    const earlyBreak = early[2];
    if (earlyBreak === undefined) throw new Error('fixture');
    earlyBreak.gapAfterMs = 2500;
    const earlyResult = chunkSentences(early, ctx, config, wordTokenizer);
    expect(earlyResult.stats.gapBoundariesUsed).toBe(0);
    expect(earlyResult.chunks[0]?.tokenCount).toBeGreaterThanOrEqual(config.minTokens);
  });

  test('R5: an under-minimum chunk takes the next sentence even when it overshoots', () => {
    // 300 tokens, then a 400-token sentence: below minTokens, so it is added.
    const sentences = [sentence(0, 300), sentence(1, 400), sentence(2, 50)];
    const { chunks } = chunkSentences(sentences, ctx, config, wordTokenizer);
    expect(chunks[0]?.tokenCount).toBe(700);
    expect(chunks[0]?.sentenceCount).toBe(2);
  });

  test('R5: a chunk past minTokens flushes rather than exceeding maxTokens', () => {
    const sentences = [sentence(0, 360), sentence(1, 400), sentence(2, 50)];
    const { chunks } = chunkSentences(sentences, ctx, config, wordTokenizer);
    expect(chunks[0]?.tokenCount).toBe(360);
  });

  test('R8: the final chunk may fall below minTokens and is never padded', () => {
    const { chunks } = chunkSentences(series(53, 10), ctx, config, wordTokenizer);
    const last = chunks[chunks.length - 1];
    expect(last).toBeDefined();
    expect(last?.tokenCount).toBeLessThan(config.minTokens);
  });

  test('R7: overlap is whole sentences within the ratio and always moves forward', () => {
    const sentences = series(200, 10);
    const { chunks } = chunkSentences(sentences, ctx, config, wordTokenizer);
    expect(chunks.length).toBeGreaterThan(2);
    for (const [position, chunk] of chunks.entries()) {
      if (position === 0) {
        expect(chunk.overlapSentenceCount).toBe(0);
        continue;
      }
      const previous = chunks[position - 1];
      if (previous === undefined) throw new Error('unreachable');
      const overlapTokens = chunk.overlapSentenceCount * 10;
      expect(overlapTokens).toBeLessThanOrEqual(config.overlapRatio * previous.tokenCount);
      expect(chunk.overlapSentenceCount).toBeLessThan(previous.sentenceCount);
      expect(chunk.startMs).toBeLessThan(previous.endMs + 1);
    }
    // Forward progress: every sentence appears, indices strictly increase.
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });

  test('timestamps span first to last sentence, and consecutive chunks may overlap', () => {
    const { chunks } = chunkSentences(series(120, 20), ctx, config, wordTokenizer);
    for (const chunk of chunks) {
      expect(chunk.endMs).toBeGreaterThanOrEqual(chunk.startMs);
    }
    const [first, second] = chunks;
    if (first === undefined || second === undefined) throw new Error('need two chunks');
    expect(second.startMs).toBeLessThan(first.endMs);
  });
});

describe('chunkSentences — edges', () => {
  test('an empty transcript yields no chunks and zeroed stats', () => {
    expect(chunkSentences([], ctx, config, wordTokenizer)).toEqual({
      chunks: [],
      stats: { sentenceCount: 0, oversizedSentences: 0, gapBoundariesUsed: 0 },
    });
  });

  test('a single short sentence yields exactly one chunk', () => {
    const { chunks } = chunkSentences([sentence(0, 4)], ctx, config, wordTokenizer);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.tokenCount).toBe(4);
    expect(chunks[0]?.sentenceCount).toBe(1);
  });

  test('very short sentences still accumulate into full-size chunks', () => {
    const { chunks } = chunkSentences(series(400, 2), ctx, config, wordTokenizer);
    expect(chunks[0]?.tokenCount).toBeGreaterThanOrEqual(config.minTokens);
  });

  test('one long unpunctuated paragraph becomes one oversized chunk', () => {
    const { chunks, stats } = chunkSentences([sentence(0, 2000)], ctx, config, wordTokenizer);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.tokenCount).toBe(2000);
    expect(stats.oversizedSentences).toBe(1);
  });
});

describe('chunkSentences — identity and determinism', () => {
  test('identical input produces identical chunk keys', () => {
    const input = series(60, 20);
    const first = chunkSentences(input, ctx, config, wordTokenizer);
    const second = chunkSentences(series(60, 20), ctx, config, wordTokenizer);
    expect(first.chunks.map((chunk) => chunk.chunkKey)).toEqual(
      second.chunks.map((chunk) => chunk.chunkKey),
    );
  });

  test('changing the chunking version or embedding model changes every key', () => {
    const input = series(60, 20);
    const base = chunkSentences(input, ctx, config, wordTokenizer).chunks[0]?.chunkKey;
    const versioned = chunkSentences(input, ctx, { ...config, version: 'v2' }, wordTokenizer)
      .chunks[0]?.chunkKey;
    const remodelled = chunkSentences(
      input,
      { ...ctx, embeddingModel: 'text-embedding-3-large' },
      config,
      wordTokenizer,
    ).chunks[0]?.chunkKey;
    expect(versioned).not.toBe(base);
    expect(remodelled).not.toBe(base);
  });

  test('records the persistence metadata every chunk row needs', () => {
    const { chunks } = chunkSentences(series(60, 20), ctx, config, wordTokenizer);
    expect(chunks[0]).toMatchObject({
      chunkingVersion: 'v1',
      tokenizer: 'test-words',
      embeddingModel: 'text-embedding-3-small',
      chunkIndex: 0,
    });
  });

  test('reports sentence count in stats', () => {
    expect(chunkSentences(series(37, 10), ctx, config, wordTokenizer).stats.sentenceCount).toBe(37);
  });
});
