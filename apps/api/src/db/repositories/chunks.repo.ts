import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { chunks } from '../schema';

export interface ChunkInsert {
  transcriptId: string;
  cohortId: string;
  moduleId: string;
  classId: string;
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
  embeddingDimensions: number;
}

export interface HydratedChunk {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  transcriptId: string;
  classId: string;
  className: string;
  moduleId: string;
  moduleName: string;
}

// Keeps one INSERT well under Postgres's 65535-param limit even for a long
// class (~15 columns/row × 500 rows = 7500 params).
const INSERT_BATCH_SIZE = 500;

/**
 * `chunk_key` is a pure function of content (spec §5.4), so
 * ON CONFLICT (chunk_key) DO NOTHING makes re-ingestion a no-op at the
 * database level: `inserted` counts only rows this call actually wrote.
 */
export async function bulkInsertChunks(
  db: Database,
  rows: ChunkInsert[],
): Promise<{ inserted: number }> {
  let inserted = 0;

  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
    if (batch.length === 0) continue;

    const written = await db
      .insert(chunks)
      .values(
        batch.map((row) => ({
          transcriptId: row.transcriptId,
          cohortId: row.cohortId,
          moduleId: row.moduleId,
          classId: row.classId,
          chunkKey: row.chunkKey,
          chunkIndex: row.chunkIndex,
          text: row.text,
          startMs: row.startMs,
          endMs: row.endMs,
          tokenCount: row.tokenCount,
          sentenceCount: row.sentenceCount,
          overlapSentenceCount: row.overlapSentenceCount,
          chunkingVersion: row.chunkingVersion,
          tokenizer: row.tokenizer,
          embeddingModel: row.embeddingModel,
          embeddingDimensions: row.embeddingDimensions,
        })),
      )
      .onConflictDoNothing({ target: chunks.chunkKey })
      .returning({ id: chunks.id });

    inserted += written.length;
  }

  return { inserted };
}

export async function listPendingEmbeddingChunks(
  db: Database,
  transcriptId: string,
  limit: number,
): Promise<Array<{ id: string; text: string }>> {
  return db
    .select({ id: chunks.id, text: chunks.text })
    .from(chunks)
    .where(and(eq(chunks.transcriptId, transcriptId), isNull(chunks.embedding)))
    .orderBy(asc(chunks.chunkIndex))
    .limit(limit);
}

/**
 * Raw SQL: pgvector's text input form is the literal `'[1,2,3]'`, which
 * Drizzle's query builder has no typed way to bind for an UPDATE. The
 * `WHERE embedding IS NULL` guard is load-bearing (spec §7.2) — a retried
 * embed step must never clobber a chunk another attempt already embedded.
 */
export async function setChunkEmbeddings(
  db: Database,
  updates: Array<{ id: string; embedding: number[] }>,
): Promise<number> {
  let updated = 0;

  for (const update of updates) {
    const vectorLiteral = `[${update.embedding.join(',')}]`;
    const result = await db.execute(sql`
      UPDATE chunks
      SET embedding = ${vectorLiteral}::vector, embedded_at = now()
      WHERE id = ${update.id}::uuid AND embedding IS NULL
    `);
    updated += result.rowCount ?? 0;
  }

  return updated;
}

export async function countChunks(
  db: Database,
  transcriptId: string,
): Promise<{ total: number; embedded: number }> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      embedded: sql<number>`count(*) filter (where embedding is not null)::int`,
    })
    .from(chunks)
    .where(eq(chunks.transcriptId, transcriptId));

  return { total: row?.total ?? 0, embedded: row?.embedded ?? 0 };
}

/**
 * Raw SQL: ordering by `array_position` — the mechanism that preserves RRF
 * rank order through hydration (spec §12.2) — has no Drizzle query-builder
 * equivalent. Missing ids are simply absent from the JOIN result, not
 * null-filled; `cohort_id` is filtered in the same query, never after.
 */
export async function hydrateChunksByIds(
  db: Database,
  ids: string[],
  cohortId: string,
): Promise<HydratedChunk[]> {
  if (ids.length === 0) return [];

  // `sql`${ids}`` would splat an array into a parenthesized record list
  // ($1, $2, ...), not a Postgres array literal — build ARRAY[...] explicitly
  // so both ANY() and array_position() see a real uuid[].
  const idArray = sql`ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]`;

  const result = await db.execute<{
    id: string;
    text: string;
    start_ms: number;
    end_ms: number;
    transcript_id: string;
    class_id: string;
    class_name: string;
    module_id: string;
    module_name: string;
  }>(sql`
    SELECT c.id, c.text, c.start_ms, c.end_ms, c.transcript_id,
           c.class_id, cl.name AS class_name, c.module_id, m.name AS module_name
    FROM chunks c
    JOIN classes cl ON cl.id = c.class_id
    JOIN modules m  ON m.id  = c.module_id
    WHERE c.id = ANY(${idArray}) AND c.cohort_id = ${cohortId}::uuid
    ORDER BY array_position(${idArray}, c.id)
  `);

  return result.rows.map((r) => ({
    id: r.id,
    text: r.text,
    startMs: r.start_ms,
    endMs: r.end_ms,
    transcriptId: r.transcript_id,
    classId: r.class_id,
    className: r.class_name,
    moduleId: r.module_id,
    moduleName: r.module_name,
  }));
}
