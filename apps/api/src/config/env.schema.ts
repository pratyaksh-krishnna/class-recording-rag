import { z } from 'zod';

/** Thrown at boot when configuration is invalid. Never caught — the process exits. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

const booleanish = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const reasoningEffort = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
/** Shared with LLMRequest['reasoningEffort'] (provider.ts) — one definition, not two drifting copies. */
export type ReasoningEffort = z.infer<typeof reasoningEffort>;

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();

export const EnvSchema = z.object({
  // runtime
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: port.default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // http
  // Comma-separated. Defaults to the dev web server's origin so a fresh
  // checkout can talk to its own frontend without extra configuration.
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  // database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  TEST_DATABASE_URL: z.string().optional(),
  DB_POOL_MAX: positiveInt.default(10),

  // openai
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  LLM_MODEL: z.string().min(1).default('gpt-5.6-luna'),
  LLM_REASONING_EFFORT_CONTEXTUALIZER: reasoningEffort.default('low'),
  LLM_REASONING_EFFORT_PLANNER: reasoningEffort.default('low'),
  LLM_REASONING_EFFORT_JUDGE: reasoningEffort.default('medium'),
  LLM_REASONING_EFFORT_ANSWER: reasoningEffort.default('medium'),
  LLM_TIMEOUT_MS: positiveInt.default(60_000),
  EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
  EMBEDDING_DIMENSIONS: positiveInt.default(1536),
  EMBEDDING_BATCH_SIZE: positiveInt.default(96),

  // chunking
  CHUNKING_VERSION: z.string().min(1).default('v1'),
  CHUNK_TARGET_TOKENS: positiveInt.default(500),
  CHUNK_MIN_TOKENS: positiveInt.default(350),
  CHUNK_MAX_TOKENS: positiveInt.default(650),
  CHUNK_OVERLAP_RATIO: z.coerce.number().min(0).max(0.5).default(0.125),
  CHUNK_GAP_PREFERRED_MS: z.coerce.number().int().min(0).default(2000),
  TOKENIZER_ENCODING: z.string().min(1).default('o200k_base'),

  // retrieval
  RETRIEVAL_TOP_K_VECTOR: positiveInt.default(10),
  RETRIEVAL_TOP_K_KEYWORD: positiveInt.default(10),
  RRF_K: positiveInt.default(60),
  MAX_QUERIES: positiveInt.default(6),
  MAX_SUBQUERIES: positiveInt.default(3),
  CONTEXT_TOKEN_BUDGET: positiveInt.default(8000),
  CONVERSATION_HISTORY_TOKEN_BUDGET: positiveInt.default(1500),
  ALLOW_GENERAL_KNOWLEDGE_FALLBACK: booleanish.default(true),

  // indexes
  HNSW_M: positiveInt.default(16),
  HNSW_EF_CONSTRUCTION: positiveInt.default(64),
  HNSW_EF_SEARCH: positiveInt.default(64),
  FTS_LANGUAGE: z.string().min(1).default('english'),

  // ingestion
  INGEST_CONCURRENCY: positiveInt.default(4),
  MAX_UPLOAD_BYTES: positiveInt.default(5_242_880),

  // observability
  DIAGNOSTICS_ENABLED: booleanish.default(false),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Pure. Takes its source explicitly so tests never mutate process.env.
 * Throws ConfigError listing every offending variable at once, because
 * discovering misconfiguration one variable per restart is miserable.
 */
export function loadEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `  ${path}: ${issue.message}`;
    })
    .join('\n');

  throw new ConfigError(`Invalid environment configuration:\n${details}`);
}
