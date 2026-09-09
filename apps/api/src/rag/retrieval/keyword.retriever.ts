import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client';
import type { RetrievedChunk } from './vector.retriever';

export interface KeywordRetrieverOptions {
  cohortId: string;
  query: string;
  limit: number;
  chunkingVersion: string;
  embeddingModel: string;
  ftsLanguage: string;
}

/**
 * Raw SQL: `websearch_to_tsquery`, `ts_rank_cd`, and the `tsv @@ query` match
 * have no Drizzle query-builder equivalent (spec §10.2).
 *
 * `websearch_to_tsquery` never raises a syntax error on arbitrary input —
 * unlike `to_tsquery`, it treats stray operators (`&`, `|`, unbalanced `(`)
 * as literal text rather than tsquery syntax — so adversarial user text is
 * safe here; a malformed query just produces an empty tsquery, which matches
 * nothing and returns zero rows (spec §10.2, §21).
 *
 * `cohort_id` is a required field of KeywordRetrieverOptions and sits inside
 * the WHERE clause, never applied as a post-filter (spec §21).
 */
export async function retrieveByKeyword(
  db: Database,
  options: KeywordRetrieverOptions,
): Promise<RetrievedChunk[]> {
  const result = await db.execute<{
    id: string;
    chunk_key: string;
    class_id: string;
    module_id: string;
    chunk_index: number;
    score: number;
  }>(sql`
    SELECT c.id, c.chunk_key, c.class_id, c.module_id, c.chunk_index,
           ts_rank_cd(c.tsv, q.query) AS score
    FROM chunks c, websearch_to_tsquery(${options.ftsLanguage}, ${options.query}) AS q(query)
    WHERE c.cohort_id        = ${options.cohortId}::uuid
      AND c.chunking_version = ${options.chunkingVersion}
      AND c.embedding_model  = ${options.embeddingModel}
      AND c.embedding IS NOT NULL
      AND c.tsv @@ q.query
    ORDER BY score DESC, c.chunk_key ASC
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
}
