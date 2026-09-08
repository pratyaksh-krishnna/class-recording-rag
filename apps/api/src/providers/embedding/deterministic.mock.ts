import type { EmbeddingProvider } from './provider';

export interface DeterministicEmbeddingProviderOptions {
  model?: string;
  dimensions?: number;
}

/**
 * FNV-1a over the text bytes plus its reverse — mixing in the reversal keeps
 * short near-duplicate strings ("a" vs "aa") from seeding neighboring PRNG
 * states, which would otherwise put their vectors suspiciously close together.
 */
function hashText(text: string): number {
  let forward = 0x811c9dc5;
  let backward = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    forward = Math.imul(forward ^ code, 0x01000193);
    backward = Math.imul(backward ^ text.charCodeAt(text.length - 1 - i), 0x01000193);
  }
  return ((forward ^ backward ^ text.length) >>> 0) || 1;
}

/** Mulberry32 — small, fast, deterministic given a 32-bit seed. No crypto needed here. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** L2-normalized so cosine distance between mock vectors behaves like real embeddings. */
function embedOne(text: string, dimensions: number): number[] {
  const random = mulberry32(hashText(text));
  const vector = new Array<number>(dimensions);
  let sumSquares = 0;
  for (let i = 0; i < dimensions; i++) {
    const value = random() * 2 - 1;
    vector[i] = value;
    sumSquares += value * value;
  }
  const norm = Math.sqrt(sumSquares) || 1;
  return vector.map((value) => value / norm);
}

/**
 * No I/O, no randomness — used by integration tests and the eval harness so
 * they never pay for or depend on OpenAI. Same text always yields the same
 * vector; different text yields a different one.
 */
export function createDeterministicEmbeddingProvider(
  options: DeterministicEmbeddingProviderOptions = {},
): EmbeddingProvider {
  const model = options.model ?? 'deterministic-mock';
  const dimensions = options.dimensions ?? 1536;

  return {
    model,
    dimensions,
    async embed(texts) {
      return texts.map((text) => embedOne(text, dimensions));
    },
  };
}
