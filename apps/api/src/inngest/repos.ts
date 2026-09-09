import type { Database } from '../db/client';
import type { PipelineRepos } from '../ingestion/pipeline';
import {
  findTranscriptById,
  updateTranscriptStats,
} from '../db/repositories/transcripts.repo';
import { bulkInsertChunks, listPendingEmbeddingChunks, setChunkEmbeddings } from '../db/repositories/chunks.repo';

/**
 * Thin adapter binding db into each repository function so PipelineDeps.repos
 * can be built once at boot. Each function is a partial application of its
 * repository counterpart, fixing db as the first argument.
 */
export function createPipelineRepos(db: Database): PipelineRepos {
  return {
    findTranscriptById: (id: string) => findTranscriptById(db, id),
    updateTranscriptStats: (id: string, stats: { cueCount: number; durationMs: number }) =>
      updateTranscriptStats(db, id, stats),
    bulkInsertChunks: (rows) => bulkInsertChunks(db, rows),
    listPendingEmbeddingChunks: (transcriptId: string, limit: number) =>
      listPendingEmbeddingChunks(db, transcriptId, limit),
    setChunkEmbeddings: (updates) => setChunkEmbeddings(db, updates),
  };
}
