import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { createDeterministicEmbeddingProvider } from '../../../apps/api/src/providers/embedding/deterministic.mock';
import type { TranscriptSource, TranscriptSourceContent } from '../../../apps/api/src/ingestion/source';
import type { RagConfig } from '../../../apps/api/src/config/rag';
import {
  loadTranscriptStep,
  parseAndChunkStep,
  persistChunksStep,
  embedPendingStep,
  PermanentIngestError,
  type PipelineDeps,
  type PipelineRepos,
} from '../../../apps/api/src/ingestion/pipeline';

// In-memory fake repositories for testing
function createFakeRepos() {
  const transcripts = new Map<string, any>();
  const chunks = new Map<string, any>();

  const repos: PipelineRepos = {
    findTranscriptById: async (id: string) => {
      return transcripts.get(id) ?? null;
    },
    updateTranscriptStats: async (id: string, stats: any) => {
      const t = transcripts.get(id);
      if (t) {
        t.cueCount = stats.cueCount;
        t.durationMs = stats.durationMs;
      }
    },
    bulkInsertChunks: async (rows: any[]) => {
      let inserted = 0;
      for (const row of rows) {
        if (!chunks.has(row.chunkKey)) {
          chunks.set(row.chunkKey, { id: row.chunkKey, ...row });
          inserted++;
        }
      }
      return { inserted };
    },
    listPendingEmbeddingChunks: async (transcriptId: string, limit: number) => {
      const pending = Array.from(chunks.values()).filter(
        (c) => c.transcriptId === transcriptId && !c.embedding,
      );
      return pending.slice(0, limit).map((c) => ({ id: c.id, text: c.text }));
    },
    setChunkEmbeddings: async (updates: any[]) => {
      let updated = 0;
      for (const { id, embedding } of updates) {
        const chunk = chunks.get(id);
        if (chunk && !chunk.embedding) {
          chunk.embedding = embedding;
          updated++;
        }
      }
      return updated;
    },
  };

  return {
    repos,
    _transcripts: transcripts,
    _chunks: chunks,
    _setupTranscript: (id: string, data: any) => {
      transcripts.set(id, data);
    },
  };
}

// In-memory fake source for testing
function createFakeSource(sourceContent: Partial<TranscriptSourceContent> = {}): TranscriptSource {
  return {
    read: async () =>
      (sourceContent as TranscriptSourceContent) || {
        content: '',
        byteSize: 0,
        contentHash: '',
      },
  };
}

// Default test config
function createTestConfig(): RagConfig {
  return {
    llm: {
      model: 'gpt-5.6-luna',
      timeoutMs: 60_000,
      reasoningEffort: { contextualizer: 'low', planner: 'low', judge: 'medium', answer: 'medium' },
    },
    chunking: {
      version: 'v1',
      targetTokens: 500,
      minTokens: 350,
      maxTokens: 650,
      overlapRatio: 0.125,
      gapPreferredMs: 2000,
      tokenizerEncoding: 'o200k_base',
    },
    retrieval: {
      topKVector: 10,
      topKKeyword: 10,
      maxQueries: 6,
      maxSubQueries: 3,
      ftsLanguage: 'english',
    },
    rrf: { k: 60 },
    budgets: { contextTokens: 8000, conversationHistoryTokens: 1500 },
    index: { hnswM: 16, hnswEfConstruction: 64, hnswEfSearch: 64 },
    embedding: { model: 'deterministic-mock', dimensions: 1536, batchSize: 2 },
    features: { allowGeneralKnowledgeFallback: true, diagnosticsEnabled: false },
  };
}

// Simple sample transcript with a few cues
const SIMPLE_TRANSCRIPT = `WEBVTT

00:00:00.000 --> 00:00:05.000
Hello world.

00:00:05.500 --> 00:00:10.000
This is a test.

00:00:10.500 --> 00:00:15.000
Final sentence.
`;

// Helper to compute SHA256 hash for testing
function computeHash(content: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(content);
  return hasher.digest('hex');
}

describe('pipeline steps', () => {
  let fakeReposObj: any;
  let config: RagConfig;

  beforeEach(() => {
    fakeReposObj = createFakeRepos();
    config = createTestConfig();
  });

  describe('loadTranscriptStep', () => {
    test('loads content and verifies hash matches transcript row', async () => {
      const transcriptId = 'test-id';
      const content = 'Hello world';
      const hasher = new Bun.CryptoHasher('sha256');
      hasher.update(content);
      const contentHash = hasher.digest('hex');

      fakeReposObj._setupTranscript(transcriptId, {
        contentHash,
        byteSize: Buffer.byteLength(content, 'utf8'),
      });

      const source = createFakeSource({
        content,
        contentHash,
        byteSize: Buffer.byteLength(content, 'utf8'),
      });

      const deps: PipelineDeps = { repos: fakeReposObj.repos, source, embeddings: createDeterministicEmbeddingProvider(), config };
      const result = await loadTranscriptStep(deps, {
        transcriptId,
        sourceUri: 'file://test.vtt',
        runId: 'run-1',
      });

      expect(result.content).toBe(content);
      expect(result.byteSize).toBe(Buffer.byteLength(content, 'utf8'));
    });

    test('throws PermanentIngestError with code HASH_MISMATCH when hashes disagree', async () => {
      const transcriptId = 'test-id';
      const content = 'Hello world';
      const hasher = new Bun.CryptoHasher('sha256');
      hasher.update(content);
      const actualHash = hasher.digest('hex');
      const wrongHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      fakeReposObj._setupTranscript(transcriptId, { contentHash: actualHash });

      // Source returns wrong hash while database has correct hash
      const badSource = createFakeSource({
        content,
        contentHash: wrongHash,
        byteSize: Buffer.byteLength(content, 'utf8'),
      });

      const deps: PipelineDeps = { repos: fakeReposObj.repos, source: badSource, embeddings: createDeterministicEmbeddingProvider(), config };

      let errorThrown: any = null;
      try {
        await loadTranscriptStep(deps, {
          transcriptId,
          sourceUri: 'file://test.vtt',
          runId: 'run-1',
        });
      } catch (e) {
        errorThrown = e;
      }

      expect(errorThrown).toBeInstanceOf(PermanentIngestError);
      expect(errorThrown.code).toBe('HASH_MISMATCH');
    });
  });

  describe('parseAndChunkStep', () => {
    test('parses and chunks a valid transcript with correct metrics', async () => {
      const embeddings = createDeterministicEmbeddingProvider();
      const deps: PipelineDeps = { repos: fakeReposObj.repos, source: createFakeSource({}), embeddings, config };
      const contentHash = computeHash(SIMPLE_TRANSCRIPT);

      const result = await parseAndChunkStep(deps, {
        transcriptId: 'test-id',
        content: SIMPLE_TRANSCRIPT,
        fileName: 'test.vtt',
        cohortSlug: 'test-cohort',
        moduleSlug: 'module-1',
        classSlug: 'class-1',
        contentHash,
      });

      expect(result.chunks).toBeDefined();
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.cueCount).toBe(3);
      expect(result.sentenceCount).toBeGreaterThan(0);
      expect(result.durationMs).toBe(15000); // Last cue ends at 15 seconds
    });

    test('wraps parsing errors in PermanentIngestError', async () => {
      const embeddings = createDeterministicEmbeddingProvider();
      const deps: PipelineDeps = { repos: fakeReposObj.repos, source: createFakeSource({}), embeddings, config };
      const invalidContent = 'INVALID CONTENT WITH NO CUES';
      const contentHash = computeHash(invalidContent);

      let errorThrown: any = null;
      try {
        await parseAndChunkStep(deps, {
          transcriptId: 'test-id',
          content: invalidContent,
          fileName: 'test.vtt',
          cohortSlug: 'test-cohort',
          moduleSlug: 'module-1',
          classSlug: 'class-1',
          contentHash,
        });
      } catch (e) {
        errorThrown = e;
      }

      expect(errorThrown).toBeInstanceOf(PermanentIngestError);
    });

    test('durationMs equals the last cue endMs', async () => {
      const transcript = `WEBVTT

00:00:00.000 --> 00:00:05.000
Sentence one.

00:00:06.000 --> 00:00:12.500
Sentence two.

00:00:13.000 --> 00:00:20.000
Final sentence.`;

      const embeddings = createDeterministicEmbeddingProvider();
      const deps: PipelineDeps = { repos: fakeReposObj.repos, source: createFakeSource({}), embeddings, config };
      const contentHash = computeHash(transcript);

      const result = await parseAndChunkStep(deps, {
        transcriptId: 'test-id',
        content: transcript,
        fileName: 'test.vtt',
        cohortSlug: 'test-cohort',
        moduleSlug: 'module-1',
        classSlug: 'class-1',
        contentHash,
      });

      expect(result.durationMs).toBe(20000);
    });
  });

  describe('persistChunksStep', () => {
    test('inserts chunks with all required columns and configured embedding dimensions', async () => {
      const embeddings = createDeterministicEmbeddingProvider();
      const deps: PipelineDeps = { repos: fakeReposObj.repos, source: createFakeSource({}), embeddings, config };
      const contentHash = computeHash(SIMPLE_TRANSCRIPT);

      const parseResult = await parseAndChunkStep(deps, {
        transcriptId: 'test-id',
        content: SIMPLE_TRANSCRIPT,
        fileName: 'test.vtt',
        cohortSlug: 'test-cohort',
        moduleSlug: 'module-1',
        classSlug: 'class-1',
        contentHash,
      });

      const result = await persistChunksStep(deps, {
        chunks: parseResult.chunks,
        transcriptId: 'test-id',
        cohortId: 'cohort-1',
        moduleId: 'module-1',
        classId: 'class-1',
      });

      expect(result.inserted).toBeGreaterThan(0);

      // Verify chunks have correct dimensions
      const chunkCount = Array.from(fakeReposObj._chunks.values()).filter(
        (c: any) => c.transcriptId === 'test-id',
      ).length;
      expect(chunkCount).toBe(result.inserted);

      // Verify the first chunk has all required fields
      const firstChunk = Array.from(fakeReposObj._chunks.values())[0] as any;
      expect(firstChunk.embeddingDimensions).toBe(1536);
      expect(firstChunk.transcriptId).toBe('test-id');
      expect(firstChunk.cohortId).toBe('cohort-1');
      expect(firstChunk.moduleId).toBe('module-1');
      expect(firstChunk.classId).toBe('class-1');
    });

    test('is idempotent: calling twice with same chunks inserts zero the second time', async () => {
      const embeddings = createDeterministicEmbeddingProvider();
      const deps: PipelineDeps = { repos: fakeReposObj.repos, source: createFakeSource({}), embeddings, config };
      const contentHash = computeHash(SIMPLE_TRANSCRIPT);

      const parseResult = await parseAndChunkStep(deps, {
        transcriptId: 'test-id',
        content: SIMPLE_TRANSCRIPT,
        fileName: 'test.vtt',
        cohortSlug: 'test-cohort',
        moduleSlug: 'module-1',
        classSlug: 'class-1',
        contentHash,
      });

      const result1 = await persistChunksStep(deps, {
        chunks: parseResult.chunks,
        transcriptId: 'test-id',
        cohortId: 'cohort-1',
        moduleId: 'module-1',
        classId: 'class-1',
      });

      const result2 = await persistChunksStep(deps, {
        chunks: parseResult.chunks,
        transcriptId: 'test-id',
        cohortId: 'cohort-1',
        moduleId: 'module-1',
        classId: 'class-1',
      });

      expect(result1.inserted).toBeGreaterThan(0);
      expect(result2.inserted).toBe(0);
    });
  });

  describe('embedPendingStep', () => {
    test('stops when no rows are pending', async () => {
      const embeddings = createDeterministicEmbeddingProvider();
      const deps: PipelineDeps = { repos: fakeReposObj.repos, source: createFakeSource({}), embeddings, config };

      // Set up some chunks with embeddings already
      fakeReposObj._chunks.set('chunk-1', {
        transcriptId: 'test-id',
        id: 'chunk-1',
        text: 'Already embedded',
        embedding: [0.1, 0.2],
      });

      const result = await embedPendingStep(deps, { transcriptId: 'test-id' });
      expect(result.embedded).toBe(0);
    });

    test('embeds pending chunks in batches', async () => {
      const embeddings = createDeterministicEmbeddingProvider();
      const batchConfig: RagConfig = {
        ...config,
        embedding: { ...config.embedding, batchSize: 2 },
      };
      const deps: PipelineDeps = { repos: fakeReposObj.repos, source: createFakeSource({}), embeddings, config: batchConfig };

      // Set up 5 pending chunks
      for (let i = 0; i < 5; i++) {
        fakeReposObj._chunks.set(`chunk-${i}`, {
          transcriptId: 'test-id',
          id: `chunk-${i}`,
          text: `Chunk text ${i}`,
          embedding: null,
        });
      }

      let embedCallCount = 0;
      const originalEmbed = embeddings.embed.bind(embeddings);
      const trackedEmbeddings = {
        ...embeddings,
        embed: async (texts: string[]) => {
          embedCallCount++;
          return originalEmbed(texts);
        },
      };

      const deps2: PipelineDeps = { repos: fakeReposObj.repos, source: createFakeSource({}), embeddings: trackedEmbeddings, config: batchConfig };
      const result = await embedPendingStep(deps2, { transcriptId: 'test-id' });

      expect(result.embedded).toBe(5);
      expect(embedCallCount).toBe(3); // Batches of 2, 2, 1
    });

    test('running embedPendingStep twice embeds zero on second run', async () => {
      const embeddings = createDeterministicEmbeddingProvider();
      const deps: PipelineDeps = { repos: fakeReposObj.repos, source: createFakeSource({}), embeddings, config };

      // Set up 3 pending chunks
      for (let i = 0; i < 3; i++) {
        fakeReposObj._chunks.set(`chunk-${i}`, {
          transcriptId: 'test-id',
          id: `chunk-${i}`,
          text: `Chunk text ${i}`,
          embedding: null,
        });
      }

      const result1 = await embedPendingStep(deps, { transcriptId: 'test-id' });
      const result2 = await embedPendingStep(deps, { transcriptId: 'test-id' });

      expect(result1.embedded).toBe(3);
      expect(result2.embedded).toBe(0);
    });
  });

  describe('error handling', () => {
    test('does not log transcript text in error messages', async () => {
      const embeddings = createDeterministicEmbeddingProvider();
      const deps: PipelineDeps = { repos: fakeReposObj.repos, source: createFakeSource({}), embeddings, config };

      const secretText = 'VERY_SECRET_CONTENT_DO_NOT_LOG';
      const contentHash = computeHash(secretText);
      let errorThrown: any = null;
      try {
        await parseAndChunkStep(deps, {
          transcriptId: 'test-id',
          content: secretText,
          fileName: 'test.vtt',
          cohortSlug: 'test-cohort',
          moduleSlug: 'module-1',
          classSlug: 'class-1',
          contentHash,
        });
      } catch (e) {
        errorThrown = e;
      }

      expect(errorThrown).toBeDefined();
      if (errorThrown && errorThrown.message) {
        expect(errorThrown.message).not.toContain(secretText);
        expect(errorThrown.message).not.toContain('VERY_SECRET');
      }
    });

    test('does not include stack traces in error messages', async () => {
      const embeddings = createDeterministicEmbeddingProvider();
      const deps: PipelineDeps = { repos: fakeReposObj.repos, source: createFakeSource({}), embeddings, config };

      const invalidContent = 'INVALID CONTENT WITH NO CUES';
      const contentHash = computeHash(invalidContent);
      let errorThrown: any = null;
      try {
        await parseAndChunkStep(deps, {
          transcriptId: 'test-id',
          content: invalidContent,
          fileName: 'test.vtt',
          cohortSlug: 'test-cohort',
          moduleSlug: 'module-1',
          classSlug: 'class-1',
          contentHash,
        });
      } catch (e) {
        errorThrown = e;
      }

      expect(errorThrown).toBeDefined();
      if (errorThrown && errorThrown.message) {
        expect(errorThrown.message).not.toContain('at ');
        expect(errorThrown.message).not.toContain('.ts:');
      }
    });
  });
});
