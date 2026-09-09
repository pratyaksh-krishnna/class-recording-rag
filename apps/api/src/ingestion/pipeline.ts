import type { TranscriptSource } from './source';
import type { EmbeddingProvider } from '../providers/embedding/provider';
import type { RagConfig } from '../config/rag';
import {
  parseTranscript,
  createRuleBasedSegmenter,
  reconstructSentences,
  chunkSentences,
  createTokenizer,
  type PreparedChunk,
} from './index';
import type { TranscriptRow } from '../db/repositories/transcripts.repo';
import type { ChunkInsert } from '../db/repositories/chunks.repo';

export interface PipelineRepos {
  findTranscriptById(id: string): Promise<TranscriptRow | null>;
  updateTranscriptStats(id: string, stats: { cueCount: number; durationMs: number }): Promise<void>;
  bulkInsertChunks(rows: ChunkInsert[]): Promise<{ inserted: number }>;
  listPendingEmbeddingChunks(
    transcriptId: string,
    limit: number,
  ): Promise<Array<{ id: string; text: string }>>;
  setChunkEmbeddings(updates: Array<{ id: string; embedding: number[] }>): Promise<number>;
}

export interface PipelineDeps {
  repos: PipelineRepos;
  source: TranscriptSource;
  embeddings: EmbeddingProvider;
  config: RagConfig;
}

export class PermanentIngestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'PermanentIngestError';
  }
}

/**
 * Load transcript bytes and verify sha256 hash matches the database row.
 * Hash mismatch indicates the file changed underneath a run (permanent failure).
 */
export async function loadTranscriptStep(
  deps: PipelineDeps,
  input: { transcriptId: string; sourceUri: string; runId: string },
): Promise<{ content: string; byteSize: number }> {
  const sourceContent = await deps.source.read(input.sourceUri);

  const transcript = await deps.repos.findTranscriptById(input.transcriptId);
  if (!transcript) {
    throw new PermanentIngestError('TRANSCRIPT_NOT_FOUND', 'Transcript record not found');
  }

  if (sourceContent.contentHash !== transcript.contentHash) {
    throw new PermanentIngestError(
      'HASH_MISMATCH',
      'File hash changed between upload and ingestion; file may have been modified',
    );
  }

  return {
    content: sourceContent.content,
    byteSize: sourceContent.byteSize,
  };
}

/**
 * Parse transcript to cues, reconstruct sentences, and chunk them.
 * Wraps any error from these pure functions in PermanentIngestError since
 * retrying with identical input will not help.
 * Calls updateTranscriptStats to record cue/duration metrics.
 */
export async function parseAndChunkStep(
  deps: PipelineDeps,
  input: {
    transcriptId: string;
    content: string;
    fileName: string;
    cohortSlug: string;
    moduleSlug: string;
    classSlug: string;
    contentHash: string;
  },
): Promise<{ chunks: PreparedChunk[]; cueCount: number; sentenceCount: number; durationMs: number }> {
  try {
    // Parse the transcript
    const cues = parseTranscript(input.fileName, input.content);

    if (cues.length === 0) {
      throw new PermanentIngestError('EMPTY_TRANSCRIPT', 'Transcript contains no cues');
    }

    // Reconstruct sentences from cues
    const segmenter = createRuleBasedSegmenter();
    const sentences = reconstructSentences(cues, segmenter);

    // Create tokenizer
    const tokenizer = createTokenizer(deps.config.chunking.tokenizerEncoding);

    // Chunk the sentences
    const chunkingResult = chunkSentences(
      sentences,
      {
        cohortSlug: input.cohortSlug,
        moduleSlug: input.moduleSlug,
        classSlug: input.classSlug,
        contentHash: input.contentHash,
        embeddingModel: deps.config.embedding.model,
      },
      deps.config.chunking,
      tokenizer,
    );

    // Update transcript stats
    const lastCue = cues[cues.length - 1];
    const durationMs = lastCue?.endMs ?? 0;

    await deps.repos.updateTranscriptStats(input.transcriptId, {
      cueCount: cues.length,
      durationMs,
    });

    return {
      chunks: chunkingResult.chunks,
      cueCount: cues.length,
      sentenceCount: chunkingResult.stats.sentenceCount,
      durationMs,
    };
  } catch (error) {
    // If it's already a PermanentIngestError, re-throw it
    if (error instanceof PermanentIngestError) {
      throw error;
    }

    // Wrap any other error in PermanentIngestError with a safe message
    throw new PermanentIngestError(
      'PARSE_ERROR',
      'Failed to parse or chunk transcript: pure function error indicates data issue',
    );
  }
}

/**
 * Persist chunks to the database via bulk insert.
 * ON CONFLICT (chunk_key) DO NOTHING makes re-runs idempotent at the DB level.
 */
export async function persistChunksStep(
  deps: PipelineDeps,
  input: {
    chunks: PreparedChunk[];
    transcriptId: string;
    cohortId: string;
    moduleId: string;
    classId: string;
  },
): Promise<{ inserted: number }> {
  const chunkInserts = input.chunks.map((chunk) => ({
    transcriptId: input.transcriptId,
    cohortId: input.cohortId,
    moduleId: input.moduleId,
    classId: input.classId,
    chunkKey: chunk.chunkKey,
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    startMs: chunk.startMs,
    endMs: chunk.endMs,
    tokenCount: chunk.tokenCount,
    sentenceCount: chunk.sentenceCount,
    overlapSentenceCount: chunk.overlapSentenceCount,
    chunkingVersion: chunk.chunkingVersion,
    tokenizer: chunk.tokenizer,
    embeddingModel: chunk.embeddingModel,
    embeddingDimensions: deps.config.embedding.dimensions,
  }));

  return deps.repos.bulkInsertChunks(chunkInserts);
}

/**
 * Embed all chunks with embedding IS NULL in batches until no pending rows remain.
 * Returns the total count embedded. Running twice is safe: the second run finds
 * nothing pending and embeds nothing.
 * Guards against infinite loops by breaking and throwing if an update writes nothing.
 */
export async function embedPendingStep(
  deps: PipelineDeps,
  input: { transcriptId: string },
): Promise<{ embedded: number }> {
  let totalEmbedded = 0;
  const batchSize = deps.config.embedding.batchSize;

  while (true) {
    const pending = await deps.repos.listPendingEmbeddingChunks(input.transcriptId, batchSize);

    if (pending.length === 0) {
      break;
    }

    const texts = pending.map((p) => p.text);
    const embeddings = await deps.embeddings.embed(texts);

    const updates = pending.map((p, i) => {
      const embedding = embeddings[i];
      if (!embedding) {
        throw new Error(`embedPendingStep: embedding result at index ${i} is missing`);
      }
      return { id: p.id, embedding };
    });

    const updated = await deps.repos.setChunkEmbeddings(updates);

    if (updated === 0) {
      throw new Error('embedPendingStep: update wrote zero rows; infinite loop prevented');
    }

    totalEmbedded += updated;
  }

  return { embedded: totalEmbedded };
}
