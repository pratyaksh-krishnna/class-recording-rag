import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp } from './app';
import { env, ragConfig } from './config';
import { createPool, createDb } from './db/client';
import { createFileTranscriptSource } from './ingestion/source';
import type { PipelineDeps } from './ingestion/pipeline';
import { createPipelineRepos } from './inngest/repos';
import { createInngestFunctions, inngest } from './inngest';
import { createOpenAIEmbeddingProvider } from './providers/embedding/openai.embedding';
import { createOpenAILLMProvider } from './providers/llm/openai.llm';
import { createTokenizer } from './ingestion/tokenizer/tokenizer';
import { log } from './observability/logger';

const pool = createPool(env.DATABASE_URL, env.DB_POOL_MAX);
const db = createDb(pool);

// apps/api/src -> repo root, so this resolves the same way whether the
// process is started from the repo root or from apps/api.
const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const recordingsRoot = resolve(repoRoot, 'recordings');
const uploadsDir = resolve(repoRoot, 'uploads');

// Created at boot so the first upload does not fail on a missing directory,
// and so the ingestion source has a real path to resolve it against.
await mkdir(uploadsDir, { recursive: true });

// A pure constructor: no request is made until pipeline.embeddings.embed()
// is actually called from inside an Inngest step, so boot never blocks on
// OpenAI being reachable.
const embeddings = createOpenAIEmbeddingProvider({
  apiKey: env.OPENAI_API_KEY,
  model: ragConfig.embedding.model,
  dimensions: ragConfig.embedding.dimensions,
  batchSize: ragConfig.embedding.batchSize,
  timeoutMs: env.LLM_TIMEOUT_MS,
});

// Same lazy-construction rationale as the embedding provider above: no
// network call happens until a chat request actually reaches the orchestrator.
const llm = createOpenAILLMProvider({
  apiKey: env.OPENAI_API_KEY,
  model: ragConfig.llm.model,
});

const tokenizer = createTokenizer(ragConfig.chunking.tokenizerEncoding);

const pipeline: PipelineDeps = {
  repos: createPipelineRepos(db),
  // Seeded transcripts live under recordings/; uploads via POST /api/transcripts
  // live under uploads/ — both are valid read roots for ingestion.
  source: createFileTranscriptSource([recordingsRoot, uploadsDir]),
  embeddings,
  config: ragConfig,
};

const inngestFunctions = createInngestFunctions({
  db,
  pipeline,
  ingestConcurrency: env.INGEST_CONCURRENCY,
});

const app = createApp({
  pool,
  db,
  inngest,
  inngestServe: { client: inngest, functions: inngestFunctions },
  uploadsDir,
  transcriptsConfig: {
    maxUploadBytes: env.MAX_UPLOAD_BYTES,
    chunkingVersion: ragConfig.chunking.version,
    embeddingModel: ragConfig.embedding.model,
  },
  llm,
  embeddings,
  tokenizer,
  ragConfig,
  corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS,
});

const server = app.listen(env.PORT, () => {
  log().info({ port: env.PORT, nodeEnv: env.NODE_ENV }, 'api listening');
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log().info({ signal }, 'shutting down');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
