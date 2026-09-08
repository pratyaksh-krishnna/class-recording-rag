import { AppError } from '../../errors/AppError';
import { log } from '../../observability/logger';
import type { EmbeddingProvider } from './provider';

const EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

export interface OpenAIEmbeddingProviderOptions {
  apiKey: string;
  model: string;
  dimensions: number;
  batchSize: number;
  timeoutMs: number;
  /** Defaults to global fetch; exists only so tests never touch the network. */
  fetchImpl?: typeof fetch;
}

interface EmbeddingResponseItem {
  index: number;
  embedding: number[];
}

interface EmbeddingResponseBody {
  data: EmbeddingResponseItem[];
}

/** Shape check, not a cast: this body comes from a third party and is untyped. */
function isEmbeddingResponseBody(value: unknown): value is EmbeddingResponseBody {
  if (typeof value !== 'object' || value === null) return false;
  const { data } = value as { data?: unknown };
  if (!Array.isArray(data)) return false;
  return data.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { index?: unknown }).index === 'number' &&
      Array.isArray((item as { embedding?: unknown }).embedding),
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * A thin client over the embeddings endpoint. Batches internally and never
 * lets a provider response body, the API key, or a stack trace cross into an
 * AppError message or a log line (spec §16.3, §21) — only status codes and
 * attempt numbers are safe to record.
 */
export function createOpenAIEmbeddingProvider(options: OpenAIEmbeddingProviderOptions): EmbeddingProvider {
  const { apiKey, model, dimensions, batchSize, timeoutMs, fetchImpl = fetch } = options;

  async function embedBatch(batch: string[], attempt: number): Promise<number[][]> {
    let response: Response;
    try {
      response = await fetchImpl(EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ input: batch, model, dimensions }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      if (isAbortError(cause)) {
        log().warn({ attempt }, 'embedding request timed out');
        throw new AppError('UPSTREAM_TIMEOUT', 'Embedding request timed out.', { cause });
      }
      log().warn({ attempt }, 'embedding request failed before a response was received');
      throw new AppError('LLM_FAILED', 'Embedding request failed.', { cause });
    }

    if (!response.ok) {
      log().warn({ status: response.status, attempt }, 'embedding provider returned a non-2xx status');
      throw new AppError('LLM_FAILED', 'Embedding provider returned an error.');
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      log().warn({ status: response.status, attempt }, 'embedding provider returned an unparseable body');
      throw new AppError('LLM_FAILED', 'Embedding provider returned a malformed response.', { cause });
    }

    if (!isEmbeddingResponseBody(body)) {
      log().warn({ status: response.status, attempt }, 'embedding provider returned an unexpected response shape');
      throw new AppError('LLM_FAILED', 'Embedding provider returned a malformed response.');
    }

    // The API does not guarantee response order matches request order.
    const sorted = [...body.data].sort((a, b) => a.index - b.index);
    return sorted.map((item) => {
      if (item.embedding.length !== dimensions) {
        throw new AppError('LLM_FAILED', 'Embedding provider returned a vector of unexpected length.');
      }
      return item.embedding;
    });
  }

  return {
    model,
    dimensions,
    async embed(texts) {
      if (texts.length === 0) return [];

      const vectors: number[][] = [];
      let attempt = 0;
      for (let start = 0; start < texts.length; start += batchSize) {
        attempt += 1;
        const batch = texts.slice(start, start + batchSize);
        vectors.push(...(await embedBatch(batch, attempt)));
      }
      return vectors;
    },
  };
}
