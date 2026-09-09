import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client';

export interface RetrievedChunk {
  id: string;
  chunkKey: string;
  classId: string;
  moduleId: string;
  chunkIndex: number;
  score: number;
}

export interface VectorRetrieverOptions {
  cohortId: string;
  embedding: number[];
  limit: number;
  chunkingVersion: string;
  embeddingModel: string;
  efSearch: number;
}

/**
 * Raw SQL: pgvector's `<=>` operator and `::vector` cast have no Drizzle
 * query-builder equivalent (matches the pattern in chunks.repo.ts).
 *
 * `SET LOCAL` only survives for the lifetime of the transaction that issues
 * it, and the pool can hand two separate `db.execute` calls two different
 * connections — so the ef_search setting and the search itself run inside
 * ONE transaction on ONE connection, or the setting is silently wasted on a
 * connection nobody searches with (spec §10.1).
 *
 * `cohort_id` is a required field of VectorRetrieverOptions and sits inside
 * the WHERE clause, never applied as a post-filter — a cohort-less search
 * cannot typecheck (spec §21).
 */
export async function retrieveByVector(
  db: Database,
  options: VectorRetrieverOptions,
): Promise<RetrievedChunk[]> {
  const vectorLiteral = `[${options.embedding.join(',')}]`;
  // efSearch is server config (RagConfig), never user input, so inlining it
  // is safe — and necessary: Postgres's SET grammar does not accept a bound
  // parameter ($1) as the value, only a literal.
  const efSearch = Math.trunc(options.efSearch);

  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${efSearch}`));

    const result = await tx.execute<{
      id: string;
      chunk_key: string;
      class_id: string;
      module_id: string;
      chunk_index: number;
      score: number;
    }>(sql`
      SELECT id, chunk_key, class_id, module_id, chunk_index,
             1 - (embedding <=> ${vectorLiteral}::vector) AS score
      FROM chunks
      WHERE cohort_id        = ${options.cohortId}::uuid
        AND chunking_version = ${options.chunkingVersion}
        AND embedding_model  = ${options.embeddingModel}
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${options.limit}
    `);

    return result.rows.map((row) => ({
      id: row.id,
      chunkKey: row.chunk_key,
      classId: row.class_id,
      moduleId: row.module_id,
      chunkIndex: row.chunk_index,
      score: row.score,
    }));
  });
}
