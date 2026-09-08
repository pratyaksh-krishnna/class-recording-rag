import { test, expect, describe, mock } from 'bun:test';
import { createDeterministicEmbeddingProvider } from '../../../apps/api/src/providers/embedding/deterministic.mock';
import { createOpenAIEmbeddingProvider } from '../../../apps/api/src/providers/embedding/openai.embedding';
import { isAppError } from '../../../apps/api/src/errors/AppError';

function magnitude(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

describe('createDeterministicEmbeddingProvider', () => {
  test('identical input produces identical vectors', async () => {
    const provider = createDeterministicEmbeddingProvider();
    const [a] = await provider.embed(['hello class']);
    const [b] = await provider.embed(['hello class']);
    expect(a).toEqual(b);
  });

  test('different input produces different vectors', async () => {
    const provider = createDeterministicEmbeddingProvider();
    const [a] = await provider.embed(['hello class']);
    const [b] = await provider.embed(['goodbye class']);
    expect(a).not.toEqual(b);
  });

  test('every vector has the configured dimension', async () => {
    const provider = createDeterministicEmbeddingProvider({ dimensions: 8 });
    const vectors = await provider.embed(['one', 'two', 'three']);
    for (const vector of vectors) {
      expect(vector.length).toBe(8);
    }
  });

  test('L2 norm is approximately 1', async () => {
    const provider = createDeterministicEmbeddingProvider();
    const [vector] = await provider.embed(['cosine similarity is a normalized dot product']);
    expect(vector).toBeDefined();
    expect(magnitude(vector!)).toBeCloseTo(1, 6);
  });

  test('empty array returns empty result', async () => {
    const provider = createDeterministicEmbeddingProvider();
    expect(await provider.embed([])).toEqual([]);
  });

  test('defaults to model deterministic-mock and 1536 dimensions', () => {
    const provider = createDeterministicEmbeddingProvider();
    expect(provider.model).toBe('deterministic-mock');
    expect(provider.dimensions).toBe(1536);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function embeddingBody(vectors: number[][], order?: number[]): { data: { index: number; embedding: number[] }[] } {
  const indices = order ?? vectors.map((_, i) => i);
  return {
    data: indices.map((index, position) => ({ index, embedding: vectors[position]! })),
  };
}

describe('createOpenAIEmbeddingProvider', () => {
  test('empty input makes zero fetch calls', async () => {
    const fetchImpl = mock(async () => jsonResponse(embeddingBody([])));
    const provider = createOpenAIEmbeddingProvider({
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      dimensions: 4,
      batchSize: 2,
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await provider.embed([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('batches respect batchSize', async () => {
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body)) as { input: string[] };
      return jsonResponse(embeddingBody(parsed.input.map((_, i) => [i, i, i, i])));
    });
    const provider = createOpenAIEmbeddingProvider({
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      dimensions: 4,
      batchSize: 2,
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.embed(['a', 'b', 'c']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('preserves global order across batches', async () => {
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body)) as { input: string[] };
      // Each vector encodes the text it came from so we can check final ordering.
      return jsonResponse(embeddingBody(parsed.input.map((text) => [text.charCodeAt(0), 0, 0, 0])));
    });
    const provider = createOpenAIEmbeddingProvider({
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      dimensions: 4,
      batchSize: 2,
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const vectors = await provider.embed(['a', 'b', 'c']);
    expect(vectors.map((v) => v[0])).toEqual(['a', 'b', 'c'].map((t) => t.charCodeAt(0)));
  });

  test('re-sorts an out-of-order index field from the response', async () => {
    const fetchImpl = mock(async () =>
      jsonResponse(
        embeddingBody(
          [
            [1, 1, 1, 1],
            [0, 0, 0, 0],
          ],
          [1, 0],
        ),
      ),
    );
    const provider = createOpenAIEmbeddingProvider({
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      dimensions: 4,
      batchSize: 5,
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const vectors = await provider.embed(['first', 'second']);
    expect(vectors).toEqual([
      [0, 0, 0, 0],
      [1, 1, 1, 1],
    ]);
  });

  test('non-2xx response throws AppError LLM_FAILED without leaking the response body', async () => {
    const secretBody = 'internal upstream diagnostic detail that must never reach the client';
    const fetchImpl = mock(async () => new Response(secretBody, { status: 500 }));
    const provider = createOpenAIEmbeddingProvider({
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      dimensions: 4,
      batchSize: 5,
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    let caught: unknown;
    try {
      await provider.embed(['x']);
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    expect((caught as { code?: string }).code).toBe('LLM_FAILED');
    expect((caught as Error).message).not.toContain(secretBody);
  });

  test('an AbortError from fetchImpl throws AppError UPSTREAM_TIMEOUT', async () => {
    const fetchImpl = mock(async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      throw abortError;
    });
    const provider = createOpenAIEmbeddingProvider({
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      dimensions: 4,
      batchSize: 5,
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    let caught: unknown;
    try {
      await provider.embed(['x']);
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    expect((caught as { code?: string }).code).toBe('UPSTREAM_TIMEOUT');
  });

  test('a dimension mismatch throws', async () => {
    const fetchImpl = mock(async () => jsonResponse(embeddingBody([[1, 2, 3]])));
    const provider = createOpenAIEmbeddingProvider({
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      dimensions: 4,
      batchSize: 5,
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    let caught: unknown;
    try {
      await provider.embed(['x']);
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    expect((caught as { code?: string }).code).toBe('LLM_FAILED');
  });

  test('a malformed response body throws AppError LLM_FAILED', async () => {
    const fetchImpl = mock(async () => new Response('not json', { status: 200 }));
    const provider = createOpenAIEmbeddingProvider({
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      dimensions: 4,
      batchSize: 5,
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    let caught: unknown;
    try {
      await provider.embed(['x']);
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    expect((caught as { code?: string }).code).toBe('LLM_FAILED');
  });
});
