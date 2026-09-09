import { AppError } from '../../errors/AppError';
import type { Database } from '../../db/client';
import type { RagConfig } from '../../config/rag';
import { span } from '../../observability/trace';
import type { EmbeddingProvider } from '../../providers/embedding/provider';
import type { RankedList } from '../fusion/rrf';
import { retrieveByKeyword } from './keyword.retriever';
import { retrieveByVector } from './vector.retriever';

export interface PlannedQuery {
  label: string;
  text: string;
}

export interface HybridRetrievalResult {
  lists: RankedList[];
  diagnostics: { listId: string; count: number; latencyMs: number }[];
}

interface HybridRetrievalDeps {
  db: Database;
  embeddings: EmbeddingProvider;
  config: RagConfig;
}

interface HybridRetrievalInput {
  cohortId: string;
  queries: PlannedQuery[];
}

interface TaskOutcome {
  listId: string;
  queryLabel: string;
  retriever: 'vector' | 'keyword';
  chunkIds: string[];
  latencyMs: number;
}

/**
 * Spec §10: embeddings for every planned query come from ONE batched call
 * before fan-out; then a single `Promise.allSettled` runs 2×N retrievals —
 * vector and keyword, for every planned query — all concurrently.
 *
 * Spec §16.3 graceful degradation: `allSettled` (not `all`) so one failing
 * retriever doesn't sink the rest. `span` (apps/api/src/observability/trace)
 * already logs a failing task's error before it reaches us, so a rejection
 * here just means "drop this list and keep going." Only total failure —
 * every one of the 2×N tasks rejecting — is fatal.
 */
export async function retrieveHybrid(
  deps: HybridRetrievalDeps,
  input: HybridRetrievalInput,
): Promise<HybridRetrievalResult> {
  const { db, embeddings, config } = deps;
  const { cohortId, queries } = input;

  const vectors = await embeddings.embed(queries.map((q) => q.text));

  const tasks: Promise<TaskOutcome>[] = queries.flatMap((query, index) => {
    const embedding = vectors[index];
    if (embedding === undefined) {
      // The provider contract (embedding/provider.ts) guarantees an
      // order-preserving 1:1 result — a short result means the provider
      // itself is broken, not a per-query failure `allSettled` can isolate.
      throw new AppError(
        'RETRIEVAL_FAILED',
        'Embedding provider returned fewer vectors than queries.',
      );
    }

    const vectorListId = `q${index}:vector`;
    const keywordListId = `q${index}:keyword`;

    const vectorTask = span(
      vectorListId,
      () =>
        retrieveByVector(db, {
          cohortId,
          embedding,
          limit: config.retrieval.topKVector,
          chunkingVersion: config.chunking.version,
          embeddingModel: config.embedding.model,
          efSearch: config.index.hnswEfSearch,
        }),
      { retriever: 'vector', queryLabel: query.label },
    ).then(({ result, durationMs }) => ({
      listId: vectorListId,
      queryLabel: query.label,
      retriever: 'vector' as const,
      chunkIds: result.map((chunk) => chunk.id),
      latencyMs: durationMs,
    }));

    const keywordTask = span(
      keywordListId,
      () =>
        retrieveByKeyword(db, {
          cohortId,
          query: query.text,
          limit: config.retrieval.topKKeyword,
          chunkingVersion: config.chunking.version,
          embeddingModel: config.embedding.model,
          ftsLanguage: config.retrieval.ftsLanguage,
        }),
      { retriever: 'keyword', queryLabel: query.label },
    ).then(({ result, durationMs }) => ({
      listId: keywordListId,
      queryLabel: query.label,
      retriever: 'keyword' as const,
      chunkIds: result.map((chunk) => chunk.id),
      latencyMs: durationMs,
    }));

    return [vectorTask, keywordTask];
  });

  const settled = await Promise.allSettled(tasks);

  const lists: RankedList[] = [];
  const diagnostics: HybridRetrievalResult['diagnostics'] = [];

  for (const outcome of settled) {
    if (outcome.status !== 'fulfilled') continue;
    const { listId, queryLabel, retriever, chunkIds, latencyMs } = outcome.value;
    lists.push({ id: listId, queryLabel, retriever, chunkIds });
    diagnostics.push({ listId, count: chunkIds.length, latencyMs });
  }

  if (lists.length === 0 && tasks.length > 0) {
    throw new AppError('RETRIEVAL_FAILED', 'All retrieval lists failed.');
  }

  return { lists, diagnostics };
}
