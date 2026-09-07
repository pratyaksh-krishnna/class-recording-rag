# Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo, the PostgreSQL + pgvector database with its full schema, validated configuration, structured logging, safe error handling, and a running Express server with health checks.

**Architecture:** Bun workspaces with `apps/api`, `apps/web`, and `packages/shared`. Express 5 runs on the Bun runtime. PostgreSQL 17 with pgvector runs in Docker. Schema lives in hand-written numbered SQL migrations applied by a small idempotent runner; Drizzle mirrors those tables for typed CRUD while retrieval (Phase 4) uses raw SQL. Configuration is Zod-validated at boot and fails fast.

**Tech Stack:** Bun 1.3.14, TypeScript 5, Express 5, Zod, Drizzle ORM, node-postgres, pino, Docker Compose, `pgvector/pgvector:pg17`.

**Spec:** `docs/superpowers/specs/2026-09-08-transcript-rag-design.md`

## Global Constraints

- **Runtime is Bun.** Use `bun <file>`, `bun test`, `bun install`, `bun add`. Never `npm`, `node`, `ts-node`, `jest`, or `vitest`.
- **Bun auto-loads `.env`.** Never add or import `dotenv`.
- **Express is the HTTP layer** (this overrides `CLAUDE.md`'s `Bun.serve()` guidance — the decision is recorded in spec §2 row 1).
- **`tsconfig.json` sets `strict: true` and `noUncheckedIndexedAccess: true`.** Indexed access yields `T | undefined`; every array and record lookup must be narrowed before use.
- **Branch:** `feat/transcript-rag` (already exists and is checked out).
- **Never log chunk text, question text, or answer text at `info` level** (spec §20).
- **Never serialize a stack trace or a provider error body to an HTTP client** (spec §16.3).
- Vector dimensionality is **1536**; RRF `k` default **60**; context budget **8000**; history budget **1500** (spec §22).
- Tests live in `tests/unit/**` and `tests/integration/**` at the repository root. Integration tests skip themselves when `TEST_DATABASE_URL` is unset.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | Workspace root; scripts; shared devDependencies |
| `docker-compose.yml` | Postgres 17 + pgvector, with a `rag_test` database for integration tests |
| `docker/initdb/01-create-test-db.sql` | Creates `rag_test` on first container start |
| `.env.example` | Every variable from spec §22, with defaults |
| `packages/shared/src/contracts.ts` | Request/response types shared by API and web |
| `packages/shared/src/grounding.ts` | The four-state grounding union and its runtime guard |
| `apps/api/src/config/env.schema.ts` | Zod schema + pure `loadEnv(source)` — no side effects, so it is testable |
| `apps/api/src/config/index.ts` | The `env` singleton; the only module that reads `process.env` |
| `apps/api/src/config/rag.ts` | Derives chunking/retrieval/RRF/budget config and validates invariants |
| `apps/api/migrations/0001_init.sql` | The complete schema from spec §3.1 |
| `apps/api/migrations/run.ts` | Idempotent migration runner + `schema_migrations` ledger |
| `apps/api/src/db/client.ts` | `pg.Pool` + Drizzle instance |
| `apps/api/src/db/schema.ts` | Drizzle table definitions mirroring the SQL |
| `apps/api/src/observability/context.ts` | `AsyncLocalStorage` request context |
| `apps/api/src/observability/logger.ts` | pino base logger + context-aware child |
| `apps/api/src/errors/AppError.ts` | Typed error codes → HTTP status |
| `apps/api/src/http/middleware/requestContext.ts` | Assigns `requestId`, enters the context store |
| `apps/api/src/http/middleware/errorHandler.ts` | `AppError` → safe JSON; unknown → generic 500 |
| `apps/api/src/http/routes/health.routes.ts` | `/health` and `/ready` |
| `apps/api/src/app.ts` | `createApp(deps)` — assembles middleware and routes |
| `apps/api/src/index.ts` | Boot: load config, create pool, listen |

---

## Task 1: Workspace scaffold and shared contracts

**Files:**
- Modify: `package.json`
- Create: `packages/shared/package.json`
- Create: `packages/shared/src/grounding.ts`
- Create: `packages/shared/src/contracts.ts`
- Create: `packages/shared/src/index.ts`
- Create: `apps/api/package.json`
- Test: `tests/unit/shared/grounding.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `GroundingStatus` (union type), `isGroundingStatus(value: unknown): value is GroundingStatus`, `GROUNDING_STATUSES` (readonly tuple), and the `ChatRequest` / `ChatResponse` / `Source` / `Diagnostics` / `ApiErrorBody` interfaces. Every later task and both apps import these from `@rag/shared`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/shared/grounding.test.ts`:

```ts
import { test, expect, describe } from 'bun:test';
import { GROUNDING_STATUSES, isGroundingStatus } from '../../../packages/shared/src/grounding';

describe('grounding status', () => {
  test('exposes exactly the four statuses from the spec', () => {
    expect([...GROUNDING_STATUSES]).toEqual([
      'course_grounded',
      'partially_grounded',
      'general_knowledge',
      'conflicting',
    ]);
  });

  test('accepts every valid status', () => {
    for (const status of GROUNDING_STATUSES) {
      expect(isGroundingStatus(status)).toBe(true);
    }
  });

  test('rejects unknown strings and non-strings', () => {
    expect(isGroundingStatus('course-grounded')).toBe(false);
    expect(isGroundingStatus('')).toBe(false);
    expect(isGroundingStatus(null)).toBe(false);
    expect(isGroundingStatus(undefined)).toBe(false);
    expect(isGroundingStatus(42)).toBe(false);
    expect(isGroundingStatus({ status: 'course_grounded' })).toBe(false);
  });

  test('keeps numeric confidence out of the contract entirely', async () => {
    // Spec §23: a similarity score is not a calibrated probability, so no
    // confidence field may ever appear in the response contract.
    const text = await Bun.file(
      new URL('../../../packages/shared/src/contracts.ts', import.meta.url),
    ).text();
    expect(text).not.toContain('confidence');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/shared/grounding.test.ts`
Expected: FAIL — cannot resolve `packages/shared/src/grounding`.

- [ ] **Step 3: Create the workspace root**

Replace `package.json` with:

```json
{
  "name": "rag-class-recordings",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "migrate": "bun run apps/api/migrations/run.ts",
    "dev:api": "bun --hot apps/api/src/index.ts",
    "test": "bun test"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5"
  }
}
```

- [ ] **Step 4: Create the shared package**

Create `packages/shared/package.json`:

```json
{
  "name": "@rag/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

Create `packages/shared/src/grounding.ts`:

```ts
/**
 * The four grounding states the API may return (spec §23).
 * Deliberately no numeric confidence: a similarity score is not a calibrated
 * probability, and presenting one as certainty would mislead.
 */
export const GROUNDING_STATUSES = [
  'course_grounded',
  'partially_grounded',
  'general_knowledge',
  'conflicting',
] as const;

export type GroundingStatus = (typeof GROUNDING_STATUSES)[number];

export function isGroundingStatus(value: unknown): value is GroundingStatus {
  return (
    typeof value === 'string' &&
    (GROUNDING_STATUSES as readonly string[]).includes(value)
  );
}
```

Create `packages/shared/src/contracts.ts`:

```ts
import type { GroundingStatus } from './grounding';

/**
 * A single piece of course evidence cited in an answer.
 *
 * Every field here originates from the database (spec §20, §49). The model
 * never contributes a timestamp, module name, class name, or chunk id — it
 * only emits `[SOURCE_N]` markers that the backend resolves against this data.
 */
export interface Source {
  /** Stable marker used in the answer text, e.g. 'SOURCE_1'. */
  id: string;
  chunkId: string;
  transcriptId: string;
  moduleId: string;
  moduleName: string;
  classId: string;
  className: string;
  /** Display form, e.g. '12:31'. */
  startTime: string;
  endTime: string;
  /** Exact offsets. Present so V2 playback seeking needs no API change (spec §43). */
  startMs: number;
  endMs: number;
  /** Short transcript snippet for the evidence card (spec §28). */
  excerpt: string;
}

export interface ChatRequest {
  question: string;
  /** Omit to start a new conversation. */
  conversationId?: string;
}

export interface RetrievalDiagnostic {
  listId: string;
  count: number;
  latencyMs: number;
}

/** Internal observability only. Returned when DIAGNOSTICS_ENABLED is true. */
export interface Diagnostics {
  requestId: string;
  queries: { label: string; text: string }[];
  retrieval: RetrievalDiagnostic[];
  fusedCount: number;
  contextChunkCount: number;
  contextTokens: number;
  judgeVerdict: string;
  latencyMs: {
    contextualize?: number;
    plan: number;
    retrieve: number;
    judge: number;
    generate: number;
    total: number;
  };
  tokenUsage?: { plan: number; judge: number; generate: number };
}

export interface ChatResponse {
  conversationId: string;
  messageId: string;
  answer: string;
  groundingStatus: GroundingStatus;
  sources: Source[];
  diagnostics?: Diagnostics;
}

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'COHORT_NOT_FOUND'
  | 'CONVERSATION_NOT_FOUND'
  | 'TRANSCRIPT_NOT_FOUND'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'RETRIEVAL_FAILED'
  | 'LLM_FAILED'
  | 'UPSTREAM_TIMEOUT'
  | 'INTERNAL_ERROR';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
    details?: unknown;
  };
}
```

Create `packages/shared/src/index.ts`:

```ts
export * from './grounding';
export * from './contracts';
```

- [ ] **Step 5: Create the API package and install dependencies**

Create `apps/api/package.json`:

```json
{
  "name": "@rag/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts"
}
```

Run:

```bash
bun install
bun add --cwd apps/api express zod drizzle-orm pg pino @rag/shared
bun add --cwd apps/api --dev @types/express @types/pg pino-pretty
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test tests/unit/shared/grounding.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock packages apps/api/package.json tests
git commit -m "feat: monorepo workspaces and shared API contracts"
```

---

## Task 2: PostgreSQL with pgvector via Docker Compose

**Files:**
- Create: `docker-compose.yml`
- Create: `docker/initdb/01-create-test-db.sql`
- Create: `.env.example`
- Modify: `.gitignore`
- Test: `tests/integration/db/extension.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a running Postgres at `postgres://rag:rag@localhost:5432/rag` with a sibling `rag_test` database, and `.env.example` documenting every variable in spec §22.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/db/extension.test.ts`:

```ts
import { test, expect, describe, afterAll } from 'bun:test';
import { Client } from 'pg';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('postgres container', () => {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  let connected = false;

  afterAll(async () => {
    if (connected) await client.end();
  });

  test('accepts connections', async () => {
    await client.connect();
    connected = true;
    const { rows } = await client.query<{ one: number }>('SELECT 1 AS one');
    expect(rows[0]?.one).toBe(1);
  });

  test('can create the vector extension', async () => {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    const { rows } = await client.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    expect(rows[0]?.extname).toBe('vector');
  });

  test('supports cosine distance on a vector literal', async () => {
    const { rows } = await client.query<{ distance: number }>(
      "SELECT '[1,0,0]'::vector <=> '[1,0,0]'::vector AS distance",
    );
    expect(Number(rows[0]?.distance)).toBeCloseTo(0, 6);
  });
});
```

- [ ] **Step 2: Run the test to verify it skips**

Run: `bun test tests/integration/db/extension.test.ts`
Expected: the suite is SKIPPED, because `TEST_DATABASE_URL` is not set yet. This confirms the skip guard works before it confirms the database does.

- [ ] **Step 3: Write the Compose file and init script**

Create `docker-compose.yml` (Compose v5 — no `version:` key, it is obsolete):

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    container_name: rag_postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: rag
      POSTGRES_PASSWORD: rag
      POSTGRES_DB: rag
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/initdb:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U rag -d rag"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  pgdata:
```

Create `docker/initdb/01-create-test-db.sql`:

```sql
-- Runs once, on first initialisation of the data volume.
-- Integration tests target this database so they can truncate freely
-- without touching development data.
CREATE DATABASE rag_test;
```

- [ ] **Step 4: Write `.env.example`**

Create `.env.example`:

```bash
# ── runtime ───────────────────────────────────────────────
NODE_ENV=development
PORT=3000
LOG_LEVEL=info

# ── database ──────────────────────────────────────────────
DATABASE_URL=postgres://rag:rag@localhost:5432/rag
# Unset this to skip integration tests.
TEST_DATABASE_URL=postgres://rag:rag@localhost:5432/rag_test

# ── openai ────────────────────────────────────────────────
OPENAI_API_KEY=
LLM_MODEL=gpt-5.6-luna
LLM_REASONING_EFFORT_CONTEXTUALIZER=low
LLM_REASONING_EFFORT_PLANNER=low
LLM_REASONING_EFFORT_JUDGE=medium
LLM_REASONING_EFFORT_ANSWER=medium
LLM_TIMEOUT_MS=60000
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
EMBEDDING_BATCH_SIZE=96

# ── chunking (spec §6) ────────────────────────────────────
CHUNKING_VERSION=v1
CHUNK_TARGET_TOKENS=500
CHUNK_MIN_TOKENS=350
CHUNK_MAX_TOKENS=650
CHUNK_OVERLAP_RATIO=0.125
CHUNK_GAP_PREFERRED_MS=2000
TOKENIZER_ENCODING=o200k_base

# ── retrieval (spec §10, §11, §12) ────────────────────────
RETRIEVAL_TOP_K_VECTOR=10
RETRIEVAL_TOP_K_KEYWORD=10
RRF_K=60
MAX_QUERIES=6
MAX_SUBQUERIES=3
CONTEXT_TOKEN_BUDGET=8000
CONVERSATION_HISTORY_TOKEN_BUDGET=1500
ALLOW_GENERAL_KNOWLEDGE_FALLBACK=true

# ── indexes (spec §15) ────────────────────────────────────
HNSW_M=16
HNSW_EF_CONSTRUCTION=64
HNSW_EF_SEARCH=64
FTS_LANGUAGE=english

# ── ingestion ─────────────────────────────────────────────
INGEST_CONCURRENCY=4
MAX_UPLOAD_BYTES=5242880

# ── observability ─────────────────────────────────────────
DIAGNOSTICS_ENABLED=false

# ── frontend ──────────────────────────────────────────────
VITE_API_BASE_URL=http://localhost:3000
```

- [ ] **Step 5: Ignore local artefacts**

Append to `.gitignore`:

```
# local transcript corpus (large, not source)
recordings/

# seed manifest is generated, then hand-edited locally
seed.manifest.json

# evaluation output
apps/api/evals/results/
```

- [ ] **Step 6: Start the database and run the test**

```bash
docker compose up -d
docker compose ps          # wait until postgres is "healthy"
cp .env.example .env
bun test tests/integration/db/extension.test.ts
```

Expected: PASS — 3 tests. `.env` supplies `TEST_DATABASE_URL`, so the suite now runs instead of skipping.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml docker .env.example .gitignore tests
git commit -m "feat: pgvector postgres via docker compose"
```

---

## Task 3: Validated configuration

**Files:**
- Create: `apps/api/src/config/env.schema.ts`
- Create: `apps/api/src/config/index.ts`
- Create: `apps/api/src/config/rag.ts`
- Test: `tests/unit/config/env.schema.test.ts`
- Test: `tests/unit/config/rag.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `EnvSchema` (Zod), `type Env = z.infer<typeof EnvSchema>`, `loadEnv(source: Record<string, string | undefined>): Env`, `class ConfigError extends Error`
  - `env: Env` (singleton, from `apps/api/src/config/index.ts`)
  - `buildRagConfig(env: Env): RagConfig` where `RagConfig` has `chunking`, `retrieval`, `rrf`, `budgets`, `index`, `features` sub-objects
  - `ragConfig: RagConfig` singleton

`loadEnv` takes its source as a parameter rather than reading `process.env` directly. That is what makes it testable without mutating global state, and it is why the singleton lives in a separate module.

- [ ] **Step 1: Write the failing tests for env loading**

Create `tests/unit/config/env.schema.test.ts`:

```ts
import { test, expect, describe } from 'bun:test';
import { loadEnv, ConfigError } from '../../../apps/api/src/config/env.schema';

const minimal = {
  DATABASE_URL: 'postgres://rag:rag@localhost:5432/rag',
  OPENAI_API_KEY: 'sk-test',
};

describe('loadEnv', () => {
  test('applies documented defaults', () => {
    const env = loadEnv(minimal);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.RRF_K).toBe(60);
    expect(env.CONTEXT_TOKEN_BUDGET).toBe(8000);
    expect(env.CONVERSATION_HISTORY_TOKEN_BUDGET).toBe(1500);
    expect(env.EMBEDDING_DIMENSIONS).toBe(1536);
    expect(env.CHUNK_TARGET_TOKENS).toBe(500);
    expect(env.MAX_QUERIES).toBe(6);
    expect(env.LLM_MODEL).toBe('gpt-5.6-luna');
  });

  test('coerces numeric strings to numbers', () => {
    const env = loadEnv({ ...minimal, PORT: '8080', RRF_K: '20' });
    expect(env.PORT).toBe(8080);
    expect(env.RRF_K).toBe(20);
  });

  test('coerces boolean strings', () => {
    expect(loadEnv({ ...minimal, DIAGNOSTICS_ENABLED: 'true' }).DIAGNOSTICS_ENABLED).toBe(true);
    expect(loadEnv({ ...minimal, DIAGNOSTICS_ENABLED: 'false' }).DIAGNOSTICS_ENABLED).toBe(false);
    expect(loadEnv(minimal).ALLOW_GENERAL_KNOWLEDGE_FALLBACK).toBe(true);
  });

  test('fails fast when a required secret is missing', () => {
    expect(() => loadEnv({ DATABASE_URL: minimal.DATABASE_URL })).toThrow(ConfigError);
    expect(() => loadEnv({ OPENAI_API_KEY: minimal.OPENAI_API_KEY })).toThrow(ConfigError);
  });

  test('names the offending variable in the error message', () => {
    try {
      loadEnv({ DATABASE_URL: minimal.DATABASE_URL });
      throw new Error('expected loadEnv to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain('OPENAI_API_KEY');
    }
  });

  test('rejects a non-numeric port instead of silently defaulting', () => {
    expect(() => loadEnv({ ...minimal, PORT: 'not-a-port' })).toThrow(ConfigError);
  });

  test('rejects an unknown reasoning effort', () => {
    expect(() =>
      loadEnv({ ...minimal, LLM_REASONING_EFFORT_JUDGE: 'extreme' }),
    ).toThrow(ConfigError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/config/env.schema.test.ts`
Expected: FAIL — cannot resolve `apps/api/src/config/env.schema`.

- [ ] **Step 3: Implement the env schema**

Create `apps/api/src/config/env.schema.ts`:

```ts
import { z } from 'zod';

/** Thrown at boot when configuration is invalid. Never caught — the process exits. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const booleanish = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const reasoningEffort = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();

export const EnvSchema = z.object({
  // runtime
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: port.default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  TEST_DATABASE_URL: z.string().optional(),

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
  ALLOW_GENERAL_KNOWLEDGE_FALLBACK: booleanish.default('true'),

  // indexes
  HNSW_M: positiveInt.default(16),
  HNSW_EF_CONSTRUCTION: positiveInt.default(64),
  HNSW_EF_SEARCH: positiveInt.default(64),
  FTS_LANGUAGE: z.string().min(1).default('english'),

  // ingestion
  INGEST_CONCURRENCY: positiveInt.default(4),
  MAX_UPLOAD_BYTES: positiveInt.default(5_242_880),

  // observability
  DIAGNOSTICS_ENABLED: booleanish.default('false'),
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/unit/config/env.schema.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Write the failing test for derived RAG config**

Create `tests/unit/config/rag.test.ts`:

```ts
import { test, expect, describe } from 'bun:test';
import { loadEnv } from '../../../apps/api/src/config/env.schema';
import { buildRagConfig } from '../../../apps/api/src/config/rag';

const base = {
  DATABASE_URL: 'postgres://rag:rag@localhost:5432/rag',
  OPENAI_API_KEY: 'sk-test',
};

describe('buildRagConfig', () => {
  test('reads RRF k from configuration rather than hardcoding it', () => {
    expect(buildRagConfig(loadEnv(base)).rrf.k).toBe(60);
    expect(buildRagConfig(loadEnv({ ...base, RRF_K: '17' })).rrf.k).toBe(17);
  });

  test('groups chunking settings from the spec', () => {
    const cfg = buildRagConfig(loadEnv(base));
    expect(cfg.chunking).toEqual({
      version: 'v1',
      targetTokens: 500,
      minTokens: 350,
      maxTokens: 650,
      overlapRatio: 0.125,
      gapPreferredMs: 2000,
      tokenizerEncoding: 'o200k_base',
    });
  });

  test('rejects a chunk range that is not min < target < max', () => {
    expect(() =>
      buildRagConfig(loadEnv({ ...base, CHUNK_MIN_TOKENS: '700' })),
    ).toThrow(/CHUNK_MIN_TOKENS/);

    expect(() =>
      buildRagConfig(loadEnv({ ...base, CHUNK_MAX_TOKENS: '400' })),
    ).toThrow(/CHUNK_MAX_TOKENS/);
  });

  test('rejects more subqueries than the total query budget allows', () => {
    expect(() =>
      buildRagConfig(loadEnv({ ...base, MAX_QUERIES: '2', MAX_SUBQUERIES: '3' })),
    ).toThrow(/MAX_QUERIES/);
  });

  test('exposes the general-knowledge fallback as a feature flag', () => {
    expect(buildRagConfig(loadEnv(base)).features.allowGeneralKnowledgeFallback).toBe(true);
    expect(
      buildRagConfig(loadEnv({ ...base, ALLOW_GENERAL_KNOWLEDGE_FALLBACK: 'false' }))
        .features.allowGeneralKnowledgeFallback,
    ).toBe(false);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test tests/unit/config/rag.test.ts`
Expected: FAIL — cannot resolve `apps/api/src/config/rag`.

- [ ] **Step 7: Implement the derived config**

Create `apps/api/src/config/rag.ts`:

```ts
import { ConfigError, type Env } from './env.schema';

export interface RagConfig {
  chunking: {
    version: string;
    targetTokens: number;
    minTokens: number;
    maxTokens: number;
    overlapRatio: number;
    gapPreferredMs: number;
    tokenizerEncoding: string;
  };
  retrieval: {
    topKVector: number;
    topKKeyword: number;
    maxQueries: number;
    maxSubQueries: number;
    ftsLanguage: string;
  };
  rrf: { k: number };
  budgets: { contextTokens: number; conversationHistoryTokens: number };
  index: { hnswM: number; hnswEfConstruction: number; hnswEfSearch: number };
  embedding: { model: string; dimensions: number; batchSize: number };
  features: { allowGeneralKnowledgeFallback: boolean; diagnosticsEnabled: boolean };
}

/**
 * Derives the RAG settings from validated env and checks the invariants that
 * Zod cannot express because they relate two variables to each other.
 * Catching these at boot beats discovering them as strange chunk sizes later.
 */
export function buildRagConfig(env: Env): RagConfig {
  if (env.CHUNK_MIN_TOKENS >= env.CHUNK_TARGET_TOKENS) {
    throw new ConfigError(
      `CHUNK_MIN_TOKENS (${env.CHUNK_MIN_TOKENS}) must be below ` +
        `CHUNK_TARGET_TOKENS (${env.CHUNK_TARGET_TOKENS})`,
    );
  }
  if (env.CHUNK_MAX_TOKENS <= env.CHUNK_TARGET_TOKENS) {
    throw new ConfigError(
      `CHUNK_MAX_TOKENS (${env.CHUNK_MAX_TOKENS}) must be above ` +
        `CHUNK_TARGET_TOKENS (${env.CHUNK_TARGET_TOKENS})`,
    );
  }
  // contextualized + rewrite + step-back + subqueries
  const minimumQueryBudget = 3 + env.MAX_SUBQUERIES;
  if (env.MAX_QUERIES < minimumQueryBudget) {
    throw new ConfigError(
      `MAX_QUERIES (${env.MAX_QUERIES}) is too small for MAX_SUBQUERIES ` +
        `(${env.MAX_SUBQUERIES}); it must be at least ${minimumQueryBudget}`,
    );
  }

  return {
    chunking: {
      version: env.CHUNKING_VERSION,
      targetTokens: env.CHUNK_TARGET_TOKENS,
      minTokens: env.CHUNK_MIN_TOKENS,
      maxTokens: env.CHUNK_MAX_TOKENS,
      overlapRatio: env.CHUNK_OVERLAP_RATIO,
      gapPreferredMs: env.CHUNK_GAP_PREFERRED_MS,
      tokenizerEncoding: env.TOKENIZER_ENCODING,
    },
    retrieval: {
      topKVector: env.RETRIEVAL_TOP_K_VECTOR,
      topKKeyword: env.RETRIEVAL_TOP_K_KEYWORD,
      maxQueries: env.MAX_QUERIES,
      maxSubQueries: env.MAX_SUBQUERIES,
      ftsLanguage: env.FTS_LANGUAGE,
    },
    rrf: { k: env.RRF_K },
    budgets: {
      contextTokens: env.CONTEXT_TOKEN_BUDGET,
      conversationHistoryTokens: env.CONVERSATION_HISTORY_TOKEN_BUDGET,
    },
    index: {
      hnswM: env.HNSW_M,
      hnswEfConstruction: env.HNSW_EF_CONSTRUCTION,
      hnswEfSearch: env.HNSW_EF_SEARCH,
    },
    embedding: {
      model: env.EMBEDDING_MODEL,
      dimensions: env.EMBEDDING_DIMENSIONS,
      batchSize: env.EMBEDDING_BATCH_SIZE,
    },
    features: {
      allowGeneralKnowledgeFallback: env.ALLOW_GENERAL_KNOWLEDGE_FALLBACK,
      diagnosticsEnabled: env.DIAGNOSTICS_ENABLED,
    },
  };
}
```

Create `apps/api/src/config/index.ts`:

```ts
import { loadEnv, type Env } from './env.schema';
import { buildRagConfig, type RagConfig } from './rag';

/**
 * The only place in the application that reads process.env.
 * Bun loads .env automatically, so no dotenv import is needed.
 */
export const env: Env = loadEnv(process.env);
export const ragConfig: RagConfig = buildRagConfig(env);

export type { Env, RagConfig };
export { ConfigError } from './env.schema';
```

- [ ] **Step 8: Run both config suites to verify they pass**

Run: `bun test tests/unit/config/`
Expected: PASS — 12 tests.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/config tests/unit/config
git commit -m "feat: fail-fast validated configuration"
```

---

## Task 4: Schema migration and idempotent runner

**Files:**
- Create: `apps/api/migrations/0001_init.sql`
- Create: `apps/api/migrations/run.ts`
- Test: `tests/integration/db/migrations.test.ts`

**Interfaces:**
- Consumes: `loadEnv` (Task 3) for the CLI entry point
- Produces: `runMigrations(connectionString: string, dir?: string): Promise<string[]>` — returns the filenames applied by *this* invocation, so an already-migrated database returns `[]`. Task 5 and every integration test from here on calls it to prepare a database.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/db/migrations.test.ts`:

```ts
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { Client } from 'pg';
import { runMigrations } from '../../../apps/api/migrations/run';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('migrations', () => {
  const url = TEST_DATABASE_URL as string;
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
    // Start from a clean slate so the test is meaningful on a re-run.
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  });

  afterAll(async () => {
    await client.end();
  });

  test('applies every migration on a fresh database', async () => {
    const applied = await runMigrations(url);
    expect(applied).toContain('0001_init.sql');
  });

  test('is idempotent — a second run applies nothing', async () => {
    const applied = await runMigrations(url);
    expect(applied).toEqual([]);
  });

  test('records what it applied', async () => {
    const { rows } = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    );
    expect(rows.map((r) => r.filename)).toContain('0001_init.sql');
  });

  test('creates every expected table', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tables = rows.map((r) => r.table_name);
    for (const expected of [
      'chunks', 'classes', 'cohorts', 'conversations', 'ingestion_runs',
      'message_citations', 'messages', 'modules', 'transcripts',
    ]) {
      expect(tables).toContain(expected);
    }
  });

  test('creates the HNSW and GIN indexes on chunks', async () => {
    const { rows } = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'chunks'`,
    );
    const defs = rows.map((r) => r.indexdef).join('\n');
    expect(defs).toContain('USING hnsw');
    expect(defs).toContain('vector_cosine_ops');
    expect(defs).toContain('USING gin');
  });

  test('chunks.tsv is a stored generated column', async () => {
    const { rows } = await client.query<{ is_generated: string }>(
      `SELECT is_generated FROM information_schema.columns
       WHERE table_name = 'chunks' AND column_name = 'tsv'`,
    );
    expect(rows[0]?.is_generated).toBe('ALWAYS');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/integration/db/migrations.test.ts`
Expected: FAIL — cannot resolve `apps/api/migrations/run`.

- [ ] **Step 3: Write the migration**

Create `apps/api/migrations/0001_init.sql` with exactly the schema from spec §3.1:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────── hierarchy

CREATE TABLE cohorts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text        NOT NULL UNIQUE,
  name        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE modules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id   uuid        NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
  slug        text        NOT NULL,
  name        text        NOT NULL,
  position    integer     NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cohort_id, slug),
  -- enables the composite FK below, which makes cross-cohort rows unrepresentable
  UNIQUE (id, cohort_id)
);
CREATE INDEX modules_cohort_position_idx ON modules (cohort_id, position);

CREATE TABLE classes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id     uuid        NOT NULL,
  module_id     uuid        NOT NULL,
  slug          text        NOT NULL,
  name          text        NOT NULL,
  position      integer     NOT NULL,
  -- V2 placeholders: nullable, written by nothing in V1, read by nothing in V1
  recording_id  text,
  recording_url text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (module_id, slug),
  UNIQUE (id, cohort_id),
  FOREIGN KEY (module_id, cohort_id)
    REFERENCES modules (id, cohort_id) ON DELETE CASCADE
);
CREATE INDEX classes_cohort_idx     ON classes (cohort_id);
CREATE INDEX classes_module_pos_idx ON classes (module_id, position);

-- ─────────────────────────────────────────── transcripts

CREATE TABLE transcripts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id     uuid        NOT NULL,
  module_id     uuid        NOT NULL,
  class_id      uuid        NOT NULL,
  format        text        NOT NULL CHECK (format IN ('srt','vtt')),
  source_uri    text        NOT NULL,
  content_hash  text        NOT NULL,
  byte_size     integer     NOT NULL,
  language      text        NOT NULL DEFAULT 'en',
  cue_count     integer,
  duration_ms   integer,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- re-uploading identical bytes resolves to the SAME row: idempotency anchor
  UNIQUE (class_id, content_hash),
  UNIQUE (id, cohort_id),
  FOREIGN KEY (class_id, cohort_id)
    REFERENCES classes (id, cohort_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX transcripts_one_active_per_class
  ON transcripts (class_id) WHERE is_active;

-- ─────────────────────────────────────────── chunks

CREATE TABLE chunks (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_key              text        NOT NULL UNIQUE,
  transcript_id          uuid        NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  cohort_id              uuid        NOT NULL,
  module_id              uuid        NOT NULL,
  class_id               uuid        NOT NULL,
  chunk_index            integer     NOT NULL,
  text                   text        NOT NULL,
  start_ms               integer     NOT NULL,
  end_ms                 integer     NOT NULL,
  token_count            integer     NOT NULL,
  sentence_count         integer     NOT NULL,
  overlap_sentence_count integer     NOT NULL DEFAULT 0,
  chunking_version       text        NOT NULL,
  tokenizer              text        NOT NULL,
  embedding_model        text        NOT NULL,
  embedding_dimensions   integer     NOT NULL,
  embedding              vector(1536),
  embedded_at            timestamptz,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (end_ms >= start_ms),
  CHECK (token_count > 0),
  UNIQUE (transcript_id, chunking_version, embedding_model, chunk_index),
  FOREIGN KEY (class_id, cohort_id)
    REFERENCES classes (id, cohort_id) ON DELETE CASCADE
);

CREATE INDEX chunks_embedding_hnsw ON chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE INDEX chunks_tsv_gin ON chunks USING gin (tsv);

CREATE INDEX chunks_scope_idx
  ON chunks (cohort_id, chunking_version, embedding_model)
  WHERE embedding IS NOT NULL;

CREATE INDEX chunks_class_order_idx ON chunks (class_id, chunk_index);

CREATE INDEX chunks_pending_embedding_idx
  ON chunks (transcript_id) WHERE embedding IS NULL;

-- ─────────────────────────────────────────── conversations

CREATE TABLE conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id   uuid        NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
  user_id     text        NOT NULL,
  title       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_user_idx
  ON conversations (user_id, cohort_id, updated_at DESC);

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             text        NOT NULL CHECK (role IN ('user','assistant')),
  content          text        NOT NULL,
  grounding_status text        CHECK (grounding_status IN
                     ('course_grounded','partially_grounded','general_knowledge','conflicting')),
  token_count      integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'assistant') OR (grounding_status IS NULL))
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at, id);

CREATE TABLE message_citations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid    NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  source_id  text    NOT NULL,
  chunk_id   uuid    NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  rank       integer NOT NULL,
  UNIQUE (message_id, source_id)
);
CREATE INDEX message_citations_message_idx ON message_citations (message_id, rank);

-- ─────────────────────────────────────────── observability

CREATE TABLE ingestion_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transcript_id    uuid REFERENCES transcripts(id) ON DELETE CASCADE,
  class_id         uuid        NOT NULL,
  event_id         text,
  status           text        NOT NULL CHECK (status IN
                     ('pending','parsing','chunking','persisting','embedding','completed','failed')),
  chunking_version text        NOT NULL,
  embedding_model  text        NOT NULL,
  cue_count        integer,
  sentence_count   integer,
  chunk_count      integer,
  embedded_count   integer,
  error_code       text,
  error_message    text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
CREATE INDEX ingestion_runs_status_idx ON ingestion_runs (status, started_at DESC);
CREATE INDEX ingestion_runs_class_idx  ON ingestion_runs (class_id, started_at DESC);
```

- [ ] **Step 4: Write the migration runner**

Create `apps/api/migrations/run.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Applies every .sql file in `dir` that has not been applied yet, in filename
 * order, each inside its own transaction. Returns the filenames applied by
 * THIS call, so an already-migrated database returns an empty array.
 *
 * Filename order is why migrations are numbered: 0001, 0002, ... Sorting is
 * lexicographic, so zero-padding is required.
 */
export async function runMigrations(
  connectionString: string,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const entries = await readdir(dir);
    const files = entries.filter((f) => f.endsWith('.sql')).sort();

    const { rows } = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations',
    );
    const already = new Set(rows.map((r) => r.filename));

    const applied: string[] = [];
    for (const file of files) {
      if (already.has(file)) continue;

      const sql = await readFile(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${file} failed: ${message}`, { cause: error });
      }
    }

    return applied;
  } finally {
    await client.end();
  }
}

// CLI entry point: `bun run migrate`
if (import.meta.main) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
    process.exit(1);
  }

  const applied = await runMigrations(connectionString);
  if (applied.length === 0) {
    console.log('Database is already up to date.');
  } else {
    for (const file of applied) console.log(`Applied ${file}`);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/integration/db/migrations.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: Apply migrations to the development database**

Run: `bun run migrate`
Expected: `Applied 0001_init.sql`. Running it again prints `Database is already up to date.`

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations tests/integration/db/migrations.test.ts
git commit -m "feat: schema migration and idempotent runner"
```

---

## Task 5: Database client, Drizzle schema, and cohort-isolation guarantees

**Files:**
- Create: `apps/api/src/db/schema.ts`
- Create: `apps/api/src/db/client.ts`
- Test: `tests/integration/db/schema.test.ts`

**Interfaces:**
- Consumes: `runMigrations` (Task 4), `env` (Task 3)
- Produces:
  - Drizzle tables `cohorts`, `modules`, `classes`, `transcripts`, `chunks`, `conversations`, `messages`, `messageCitations`, `ingestionRuns`
  - `createPool(connectionString: string): Pool`
  - `createDb(pool: Pool): NodePgDatabase<typeof schema>`
  - `closePool(pool: Pool): Promise<void>`

Every repository in Phases 3 and 4 imports these tables. `chunks.tsv` is deliberately **absent** from the Drizzle definition: it is a generated column that nothing ever writes, and keyword retrieval queries it through raw SQL.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/db/schema.test.ts`:

```ts
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { runMigrations } from '../../../apps/api/migrations/run';
import { createPool, createDb, closePool } from '../../../apps/api/src/db/client';
import { cohorts, modules, classes } from '../../../apps/api/src/db/schema';
import type { Pool } from 'pg';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('drizzle schema', () => {
  const url = TEST_DATABASE_URL as string;
  let pool: Pool;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    await runMigrations(url);
    pool = createPool(url);
    db = createDb(pool);
    await pool.query('TRUNCATE cohorts CASCADE');
  });

  afterAll(async () => {
    await pool.query('TRUNCATE cohorts CASCADE');
    await closePool(pool);
  });

  test('inserts and reads the hierarchy', async () => {
    const [cohort] = await db
      .insert(cohorts)
      .values({ slug: 'mobile-dev-cohort', name: 'mobile dev cohort' })
      .returning();
    expect(cohort?.id).toBeString();

    const [module] = await db
      .insert(modules)
      .values({ cohortId: cohort!.id, slug: 'module-7', name: 'Device Sensors', position: 7 })
      .returning();

    const [klass] = await db
      .insert(classes)
      .values({
        cohortId: cohort!.id,
        moduleId: module!.id,
        slug: 'understanding-the-gyroscope',
        name: '2. Understanding the Gyroscope',
        position: 2,
      })
      .returning();

    const found = await db.select().from(classes).where(eq(classes.id, klass!.id));
    expect(found[0]?.name).toBe('2. Understanding the Gyroscope');
    expect(found[0]?.recordingUrl).toBeNull();
  });

  test('rejects a class whose cohort disagrees with its module', async () => {
    // This is the structural cross-cohort guarantee from spec §3.2:
    // the composite FK makes the mismatch impossible, not merely unlikely.
    const [otherCohort] = await db
      .insert(cohorts)
      .values({ slug: 'other-cohort', name: 'other cohort' })
      .returning();
    const [module] = await db
      .select()
      .from(modules)
      .where(eq(modules.slug, 'module-7'));

    // Wrapped in an async IIFE: a Drizzle query builder is a thenable, and
    // expect().rejects needs a genuine Promise.
    await expect(
      (async () => {
        await db.insert(classes).values({
          cohortId: otherCohort!.id, // belongs to a different cohort
          moduleId: module!.id,
          slug: 'smuggled-class',
          name: 'Smuggled Class',
          position: 99,
        });
      })(),
    ).rejects.toThrow();
  });

  test('rejects a second active transcript for the same class', async () => {
    const [klass] = await db
      .select()
      .from(classes)
      .where(eq(classes.slug, 'understanding-the-gyroscope'));

    const base = {
      cohortId: klass!.cohortId,
      moduleId: klass!.moduleId,
      classId: klass!.id,
      format: 'vtt' as const,
      sourceUri: 'recordings/a.vtt',
      byteSize: 100,
    };

    await pool.query(
      `INSERT INTO transcripts (cohort_id, module_id, class_id, format, source_uri, content_hash, byte_size)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [base.cohortId, base.moduleId, base.classId, base.format, base.sourceUri, 'hash-a', base.byteSize],
    );

    await expect(
      (async () => {
        await pool.query(
          `INSERT INTO transcripts (cohort_id, module_id, class_id, format, source_uri, content_hash, byte_size)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [base.cohortId, base.moduleId, base.classId, base.format, 'recordings/b.vtt', 'hash-b', base.byteSize],
        );
      })(),
    ).rejects.toThrow();
  });

  test('rejects a duplicate transcript with identical content hash', async () => {
    const [klass] = await db
      .select()
      .from(classes)
      .where(eq(classes.slug, 'understanding-the-gyroscope'));

    await expect(
      (async () => {
        await pool.query(
          `INSERT INTO transcripts (cohort_id, module_id, class_id, format, source_uri, content_hash, byte_size, is_active)
           VALUES ($1,$2,$3,'vtt','recordings/a.vtt','hash-a',100,false)`,
          [klass!.cohortId, klass!.moduleId, klass!.id],
        );
      })(),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/integration/db/schema.test.ts`
Expected: FAIL — cannot resolve `apps/api/src/db/client`.

- [ ] **Step 3: Write the Drizzle schema**

Create `apps/api/src/db/schema.ts`:

```ts
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

/**
 * Mirrors apps/api/migrations/0001_init.sql for typed CRUD.
 *
 * The SQL file is the source of truth: drizzle-kit cannot generate
 * CREATE EXTENSION, HNSW parameters, generated tsvector columns, or partial
 * unique indexes correctly, so migrations stay hand-written and this file
 * follows them. `chunks.tsv` is intentionally omitted — it is generated,
 * never written, and read only through raw SQL in keyword retrieval.
 */

export const cohorts = pgTable('cohorts', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const modules = pgTable(
  'modules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cohortId: uuid('cohort_id').notNull().references(() => cohorts.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('modules_cohort_slug_key').on(t.cohortId, t.slug),
    index('modules_cohort_position_idx').on(t.cohortId, t.position),
  ],
);

export const classes = pgTable(
  'classes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cohortId: uuid('cohort_id').notNull(),
    moduleId: uuid('module_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    // V2 placeholders — see spec §43. Nothing in V1 writes or reads these.
    recordingId: text('recording_id'),
    recordingUrl: text('recording_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('classes_module_slug_key').on(t.moduleId, t.slug),
    index('classes_cohort_idx').on(t.cohortId),
    index('classes_module_pos_idx').on(t.moduleId, t.position),
  ],
);

export const transcripts = pgTable(
  'transcripts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cohortId: uuid('cohort_id').notNull(),
    moduleId: uuid('module_id').notNull(),
    classId: uuid('class_id').notNull(),
    format: text('format').notNull().$type<'srt' | 'vtt'>(),
    sourceUri: text('source_uri').notNull(),
    contentHash: text('content_hash').notNull(),
    byteSize: integer('byte_size').notNull(),
    language: text('language').notNull().default('en'),
    cueCount: integer('cue_count'),
    durationMs: integer('duration_ms'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('transcripts_class_hash_key').on(t.classId, t.contentHash)],
);

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chunkKey: text('chunk_key').notNull().unique(),
    transcriptId: uuid('transcript_id').notNull().references(() => transcripts.id, { onDelete: 'cascade' }),
    cohortId: uuid('cohort_id').notNull(),
    moduleId: uuid('module_id').notNull(),
    classId: uuid('class_id').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    text: text('text').notNull(),
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
    tokenCount: integer('token_count').notNull(),
    sentenceCount: integer('sentence_count').notNull(),
    overlapSentenceCount: integer('overlap_sentence_count').notNull().default(0),
    chunkingVersion: text('chunking_version').notNull(),
    tokenizer: text('tokenizer').notNull(),
    embeddingModel: text('embedding_model').notNull(),
    embeddingDimensions: integer('embedding_dimensions').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chunks_transcript_version_index_key').on(
      t.transcriptId, t.chunkingVersion, t.embeddingModel, t.chunkIndex,
    ),
    index('chunks_class_order_idx').on(t.classId, t.chunkIndex),
  ],
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cohortId: uuid('cohort_id').notNull().references(() => cohorts.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    title: text('title'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('conversations_user_idx').on(t.userId, t.cohortId, t.updatedAt)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull().$type<'user' | 'assistant'>(),
    content: text('content').notNull(),
    groundingStatus: text('grounding_status').$type<
      'course_grounded' | 'partially_grounded' | 'general_knowledge' | 'conflicting'
    >(),
    tokenCount: integer('token_count'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId, t.createdAt, t.id)],
);

export const messageCitations = pgTable(
  'message_citations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull(),
    chunkId: uuid('chunk_id').notNull().references(() => chunks.id, { onDelete: 'cascade' }),
    rank: integer('rank').notNull(),
  },
  (t) => [
    uniqueIndex('message_citations_message_source_key').on(t.messageId, t.sourceId),
    index('message_citations_message_idx').on(t.messageId, t.rank),
  ],
);

export const ingestionRuns = pgTable(
  'ingestion_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transcriptId: uuid('transcript_id').references(() => transcripts.id, { onDelete: 'cascade' }),
    classId: uuid('class_id').notNull(),
    eventId: text('event_id'),
    status: text('status').notNull().$type<
      'pending' | 'parsing' | 'chunking' | 'persisting' | 'embedding' | 'completed' | 'failed'
    >(),
    chunkingVersion: text('chunking_version').notNull(),
    embeddingModel: text('embedding_model').notNull(),
    cueCount: integer('cue_count'),
    sentenceCount: integer('sentence_count'),
    chunkCount: integer('chunk_count'),
    embeddedCount: integer('embedded_count'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('ingestion_runs_status_idx').on(t.status, t.startedAt),
    index('ingestion_runs_class_idx').on(t.classId, t.startedAt),
  ],
);
```

- [ ] **Step 4: Write the database client**

Create `apps/api/src/db/client.ts`:

```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export function createDb(pool: Pool): Database {
  return drizzle(pool, { schema });
}

export async function closePool(pool: Pool): Promise<void> {
  await pool.end();
}

export { schema };
export type { Pool };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/integration/db/schema.test.ts`
Expected: PASS — 4 tests. The second and third confirm the database itself refuses cross-cohort and duplicate-active rows.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db tests/integration/db/schema.test.ts
git commit -m "feat: drizzle schema and database client"
```

---

## Task 6: Structured logging and request context

**Files:**
- Create: `apps/api/src/observability/context.ts`
- Create: `apps/api/src/observability/logger.ts`
- Create: `apps/api/src/observability/trace.ts`
- Test: `tests/unit/observability/context.test.ts`
- Test: `tests/unit/observability/trace.test.ts`

**Interfaces:**
- Consumes: `env` (Task 3)
- Produces:
  - `interface RequestContext { requestId: string; conversationId?: string; userId?: string; cohortId?: string }`
  - `runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T`
  - `getRequestContext(): RequestContext | undefined`
  - `log(): pino.Logger` — the base logger, bound to the active context when there is one
  - `span<T>(name: string, fn: () => Promise<T>): Promise<{ result: T; durationMs: number }>`

`span` is how every latency number in spec §20 gets recorded. Phase 4 wraps each pipeline stage in it.

- [ ] **Step 1: Write the failing context test**

Create `tests/unit/observability/context.test.ts`:

```ts
import { test, expect, describe } from 'bun:test';
import {
  getRequestContext,
  runWithRequestContext,
} from '../../../apps/api/src/observability/context';

describe('request context', () => {
  test('is undefined outside a run', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  test('is readable inside a run', () => {
    runWithRequestContext({ requestId: 'req-1', cohortId: 'cohort-1' }, () => {
      expect(getRequestContext()).toEqual({ requestId: 'req-1', cohortId: 'cohort-1' });
    });
  });

  test('survives an await boundary', async () => {
    await runWithRequestContext({ requestId: 'req-2' }, async () => {
      await Promise.resolve();
      expect(getRequestContext()?.requestId).toBe('req-2');
    });
  });

  test('does not leak between sibling runs', () => {
    runWithRequestContext({ requestId: 'a' }, () => {
      expect(getRequestContext()?.requestId).toBe('a');
    });
    runWithRequestContext({ requestId: 'b' }, () => {
      expect(getRequestContext()?.requestId).toBe('b');
    });
    expect(getRequestContext()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/unit/observability/context.test.ts`
Expected: FAIL — cannot resolve `apps/api/src/observability/context`.

- [ ] **Step 3: Implement the context store**

Create `apps/api/src/observability/context.ts`:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Identifiers carried through a single request so every log line correlates
 * without threading a logger argument through every function (spec §20).
 * Content — questions, answers, chunk text — is deliberately absent.
 */
export interface RequestContext {
  requestId: string;
  conversationId?: string;
  userId?: string;
  cohortId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/unit/observability/context.test.ts`
Expected: PASS — 4 tests.

> **Note on test dependencies:** `trace.ts` imports `logger.ts`, which imports
> `config/index.ts`, which calls `loadEnv(process.env)` at module load. So
> `trace.test.ts` needs a `.env` with `DATABASE_URL` and `OPENAI_API_KEY`
> present (Task 2 creates it; Bun loads it automatically). `context.test.ts`
> imports neither and stays dependency-free.

- [ ] **Step 5: Write the failing span test**

Create `tests/unit/observability/trace.test.ts`:

```ts
import { test, expect, describe } from 'bun:test';
import { span } from '../../../apps/api/src/observability/trace';

describe('span', () => {
  test('returns the wrapped result', async () => {
    const { result } = await span('unit.test', async () => 42);
    expect(result).toBe(42);
  });

  test('measures a non-negative duration', async () => {
    const { durationMs } = await span('unit.sleep', async () => {
      await Bun.sleep(5);
      return null;
    });
    expect(durationMs).toBeGreaterThanOrEqual(4);
  });

  test('rethrows the original error', async () => {
    const boom = new Error('boom');
    await expect(
      span('unit.fail', async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test tests/unit/observability/trace.test.ts`
Expected: FAIL — cannot resolve `apps/api/src/observability/trace`.

- [ ] **Step 7: Implement the logger and span**

Create `apps/api/src/observability/logger.ts`:

```ts
import pino from 'pino';
import { env } from '../config';
import { getRequestContext } from './context';

const baseLogger = pino({
  level: env.LOG_LEVEL,
  base: undefined, // omit pid/hostname noise
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});

/**
 * Returns a logger bound to the active request context when there is one.
 *
 * Content policy (spec §20): log lengths, counts, and identifiers at info.
 * Question text, answer text, and chunk text belong at debug and nowhere else.
 */
export function log(): pino.Logger {
  const context = getRequestContext();
  return context ? baseLogger.child(context) : baseLogger;
}

export { baseLogger };
```

Create `apps/api/src/observability/trace.ts`:

```ts
import { log } from './logger';

export interface SpanResult<T> {
  result: T;
  durationMs: number;
}

/**
 * Times an async stage and logs its duration. Every pipeline stage named in
 * spec §20 is wrapped in this, which is what makes retrieval and generation
 * latency observable without scattering Date.now() through the orchestrator.
 */
export async function span<T>(
  name: string,
  fn: () => Promise<T>,
  fields: Record<string, unknown> = {},
): Promise<SpanResult<T>> {
  const startedAt = performance.now();
  try {
    const result = await fn();
    const durationMs = Math.round(performance.now() - startedAt);
    log().info({ span: name, durationMs, ...fields }, 'span completed');
    return { result, durationMs };
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    log().error(
      { span: name, durationMs, err: error instanceof Error ? error.message : String(error) },
      'span failed',
    );
    throw error;
  }
}
```

- [ ] **Step 8: Run both suites to verify they pass**

Run: `bun test tests/unit/observability/`
Expected: PASS — 7 tests.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/observability tests/unit/observability
git commit -m "feat: structured logging with request context and spans"
```

---

## Task 7: Typed errors and the safe error handler

**Files:**
- Create: `apps/api/src/errors/AppError.ts`
- Create: `apps/api/src/http/middleware/requestContext.ts`
- Create: `apps/api/src/http/middleware/errorHandler.ts`
- Test: `tests/unit/errors/AppError.test.ts`

**Interfaces:**
- Consumes: `ApiErrorCode`, `ApiErrorBody` (Task 1); `RequestContext`, `runWithRequestContext`, `log` (Task 6)
- Produces:
  - `class AppError extends Error` with `code: ApiErrorCode`, `statusCode: number`, `details?: unknown`
  - `toErrorBody(error: unknown, requestId: string): { status: number; body: ApiErrorBody }`
  - `requestContextMiddleware: RequestHandler`
  - `errorHandler: ErrorRequestHandler`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/errors/AppError.test.ts`:

```ts
import { test, expect, describe } from 'bun:test';
import { AppError, toErrorBody } from '../../../apps/api/src/errors/AppError';

describe('AppError', () => {
  test('maps each code to its documented HTTP status', () => {
    expect(new AppError('VALIDATION_ERROR', 'bad').statusCode).toBe(400);
    expect(new AppError('NOT_FOUND', 'nope').statusCode).toBe(404);
    expect(new AppError('COHORT_NOT_FOUND', 'nope').statusCode).toBe(404);
    expect(new AppError('CONVERSATION_NOT_FOUND', 'nope').statusCode).toBe(404);
    expect(new AppError('UNSUPPORTED_FILE_TYPE', 'nope').statusCode).toBe(415);
    expect(new AppError('FILE_TOO_LARGE', 'nope').statusCode).toBe(413);
    expect(new AppError('RETRIEVAL_FAILED', 'nope').statusCode).toBe(503);
    expect(new AppError('LLM_FAILED', 'nope').statusCode).toBe(503);
    expect(new AppError('UPSTREAM_TIMEOUT', 'nope').statusCode).toBe(504);
    expect(new AppError('INTERNAL_ERROR', 'nope').statusCode).toBe(500);
  });

  test('preserves the cause for logging without exposing it', () => {
    const cause = new Error('connection refused');
    const error = new AppError('RETRIEVAL_FAILED', 'Retrieval failed', { cause });
    expect(error.cause).toBe(cause);
  });
});

describe('toErrorBody', () => {
  test('serializes an AppError with its code, message and requestId', () => {
    const { status, body } = toErrorBody(
      new AppError('VALIDATION_ERROR', 'question is required', {
        details: { field: 'question' },
      }),
      'req-1',
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('question is required');
    expect(body.error.requestId).toBe('req-1');
    expect(body.error.details).toEqual({ field: 'question' });
  });

  test('converts an unknown error into a generic 500', () => {
    const { status, body } = toErrorBody(new Error('pg: password authentication failed'), 'req-2');
    expect(status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('An unexpected error occurred.');
  });

  test('never leaks a stack trace or internal message to the client', () => {
    const internal = new Error('DATABASE_URL=postgres://rag:secret@host/db is unreachable');
    internal.stack = 'Error: secret stack\n    at somewhere';
    const { body } = toErrorBody(internal, 'req-3');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('stack');
    expect(serialized).not.toContain('postgres://');
  });

  test('handles a thrown non-Error value', () => {
    const { status, body } = toErrorBody('just a string', 'req-4');
    expect(status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/unit/errors/AppError.test.ts`
Expected: FAIL — cannot resolve `apps/api/src/errors/AppError`.

- [ ] **Step 3: Implement AppError**

Create `apps/api/src/errors/AppError.ts`:

```ts
import type { ApiErrorBody, ApiErrorCode } from '@rag/shared';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  COHORT_NOT_FOUND: 404,
  CONVERSATION_NOT_FOUND: 404,
  TRANSCRIPT_NOT_FOUND: 404,
  UNSUPPORTED_FILE_TYPE: 415,
  FILE_TOO_LARGE: 413,
  RETRIEVAL_FAILED: 503,
  LLM_FAILED: 503,
  UPSTREAM_TIMEOUT: 504,
  INTERNAL_ERROR: 500,
};

export interface AppErrorOptions {
  /** Safe to return to the client — Zod field errors, allowed file types, etc. */
  details?: unknown;
  cause?: unknown;
}

/**
 * An error whose message is safe to show a user. Anything thrown that is NOT
 * an AppError is treated as internal and replaced with a generic message,
 * because an arbitrary Error may carry a connection string or a provider
 * response body (spec §16.3, §21).
 */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: ApiErrorCode;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    this.details = options.details;
  }

  get statusCode(): number {
    return STATUS_BY_CODE[this.code];
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Converts anything thrown into an HTTP status and a client-safe body.
 * Only AppError messages cross the boundary; everything else becomes a
 * generic 500 whose real detail is logged, not returned.
 */
export function toErrorBody(
  error: unknown,
  requestId: string,
): { status: number; body: ApiErrorBody } {
  if (isAppError(error)) {
    return {
      status: error.statusCode,
      body: {
        error: {
          code: error.code,
          message: error.message,
          requestId,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        requestId,
      },
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/unit/errors/AppError.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Write the middleware**

Create `apps/api/src/http/middleware/requestContext.ts`:

```ts
import type { RequestHandler } from 'express';
import { runWithRequestContext } from '../../observability/context';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

/**
 * Assigns a request id and enters the AsyncLocalStorage context so every log
 * line emitted while handling this request carries it (spec §20).
 * An inbound x-request-id is honoured so a caller can correlate across hops.
 */
export const requestContextMiddleware: RequestHandler = (req, res, next) => {
  const inbound = req.header('x-request-id');
  const requestId = inbound && inbound.length <= 128 ? inbound : crypto.randomUUID();

  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  runWithRequestContext({ requestId }, () => {
    next();
  });
};
```

Create `apps/api/src/http/middleware/errorHandler.ts`:

```ts
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, isAppError, toErrorBody } from '../../errors/AppError';
import { log } from '../../observability/logger';

/** Terminal 404 for unmatched routes. Registered after every other route. */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError('NOT_FOUND', 'Route not found.'));
};

/**
 * The single place an error becomes an HTTP response.
 * Internal detail is logged; only client-safe fields are serialized.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const requestId = req.requestId ?? 'unknown';
  const { status, body } = toErrorBody(error, requestId);

  const logPayload = {
    status,
    code: body.error.code,
    method: req.method,
    path: req.path,
    err: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
  };

  if (status >= 500 && !isAppError(error)) {
    log().error(logPayload, 'unhandled error');
  } else if (status >= 500) {
    log().error(logPayload, 'request failed');
  } else {
    log().warn(logPayload, 'request rejected');
  }

  res.status(status).json(body);
};
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/errors apps/api/src/http/middleware tests/unit/errors
git commit -m "feat: typed errors and safe error handler"
```

---

## Task 8: Express application with health checks

**Files:**
- Create: `apps/api/src/http/routes/health.routes.ts`
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/index.ts`
- Create: `tests/helpers/testServer.ts`
- Test: `tests/integration/http/health.test.ts`

**Interfaces:**
- Consumes: `createPool`, `createDb` (Task 5); `requestContextMiddleware`, `errorHandler`, `notFoundHandler` (Task 7); `env` (Task 3)
- Produces:
  - `createApp(deps: { pool: Pool }): Express`
  - `withTestServer<T>(app: Express, fn: (baseUrl: string) => Promise<T>): Promise<T>` — starts the app on an ephemeral port, runs `fn`, always closes. Every HTTP test in Phases 3–5 uses this.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/http/health.test.ts`:

```ts
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { runMigrations } from '../../../apps/api/migrations/run';
import { createPool, closePool } from '../../../apps/api/src/db/client';
import { createApp } from '../../../apps/api/src/app';
import { withTestServer } from '../../helpers/testServer';
import type { Pool } from 'pg';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('health routes', () => {
  const url = TEST_DATABASE_URL as string;
  let pool: Pool;

  beforeAll(async () => {
    await runMigrations(url);
    pool = createPool(url);
  });

  afterAll(async () => {
    await closePool(pool);
  });

  test('GET /health reports liveness without touching the database', async () => {
    const app = createApp({ pool });
    await withTestServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    });
  });

  test('GET /ready confirms the database and the vector extension', async () => {
    const app = createApp({ pool });
    await withTestServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ready`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ready', database: true, pgvector: true });
    });
  });

  test('echoes a request id on every response', async () => {
    const app = createApp({ pool });
    await withTestServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`, {
        headers: { 'x-request-id': 'trace-me' },
      });
      expect(res.headers.get('x-request-id')).toBe('trace-me');
    });
  });

  test('generates a request id when the caller supplies none', async () => {
    const app = createApp({ pool });
    await withTestServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.headers.get('x-request-id')).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  test('returns a structured error body for an unknown route', async () => {
    const app = createApp({ pool });
    await withTestServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/nope`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; requestId: string } };
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.requestId).toBeString();
      expect(JSON.stringify(body)).not.toContain('stack');
    });
  });

  test('GET /ready fails closed when the database is unreachable', async () => {
    const brokenPool = createPool('postgres://rag:wrong@localhost:5432/rag');
    const app = createApp({ pool: brokenPool });
    await withTestServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ready`);
      expect(res.status).toBe(503);
    });
    await closePool(brokenPool).catch(() => undefined);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/integration/http/health.test.ts`
Expected: FAIL — cannot resolve `apps/api/src/app`.

- [ ] **Step 3: Write the test server helper**

Create `tests/helpers/testServer.ts`:

```ts
import type { Express } from 'express';
import type { AddressInfo } from 'node:net';

/**
 * Starts `app` on an ephemeral port, runs `fn` against its base URL, and
 * always closes the server — including when `fn` throws. Used by every HTTP
 * test so no test has to manage ports or leak a listener.
 */
export async function withTestServer<T>(
  app: Express,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = app.listen(0);

  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error('test server did not bind to a port');

  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
```

- [ ] **Step 4: Write the health routes**

Create `apps/api/src/http/routes/health.routes.ts`:

```ts
import { Router } from 'express';
import type { Pool } from 'pg';
import { log } from '../../observability/logger';

export function createHealthRouter(pool: Pool): Router {
  const router = Router();

  /** Liveness. Deliberately does not touch the database. */
  router.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  /**
   * Readiness. Confirms both that the database answers and that pgvector is
   * installed, because a database without the extension cannot serve a single
   * retrieval query.
   */
  router.get('/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      const { rows } = await pool.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname = 'vector'",
      );
      const pgvector = rows.length > 0;

      if (!pgvector) {
        res.status(503).json({ status: 'not-ready', database: true, pgvector: false });
        return;
      }

      res.status(200).json({ status: 'ready', database: true, pgvector: true });
    } catch (error) {
      log().error(
        { err: error instanceof Error ? error.message : String(error) },
        'readiness check failed',
      );
      res.status(503).json({ status: 'not-ready', database: false, pgvector: false });
    }
  });

  return router;
}
```

- [ ] **Step 5: Write the app factory and entry point**

Create `apps/api/src/app.ts`:

```ts
import express, { type Express } from 'express';
import type { Pool } from 'pg';
import { requestContextMiddleware } from './http/middleware/requestContext';
import { errorHandler, notFoundHandler } from './http/middleware/errorHandler';
import { createHealthRouter } from './http/routes/health.routes';

export interface AppDependencies {
  pool: Pool;
}

/**
 * Assembles the HTTP layer. Dependencies are injected rather than imported so
 * tests can supply their own pool, and so no module-level connection is opened
 * as a side effect of importing this file.
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(requestContextMiddleware);

  app.use(createHealthRouter(deps.pool));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
```

Create `apps/api/src/index.ts`:

```ts
import { createApp } from './app';
import { env } from './config';
import { createPool } from './db/client';
import { log } from './observability/logger';

const pool = createPool(env.DATABASE_URL);
const app = createApp({ pool });

const server = app.listen(env.PORT, () => {
  log().info({ port: env.PORT, nodeEnv: env.NODE_ENV }, 'api listening');
});

async function shutdown(signal: string): Promise<void> {
  log().info({ signal }, 'shutting down');
  server.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test tests/integration/http/health.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 7: Run the whole suite and start the server**

```bash
bun test
bun run dev:api
```

Expected: every test passes. In a second terminal:

```bash
curl -i http://localhost:3000/health   # 200 {"status":"ok"}, with an x-request-id header
curl -s http://localhost:3000/ready    # {"status":"ready","database":true,"pgvector":true}
curl -s http://localhost:3000/nope     # {"error":{"code":"VALIDATION_ERROR",...}}, no stack
```

Stop the server with Ctrl-C and confirm it logs `shutting down`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/index.ts apps/api/src/http/routes tests/helpers tests/integration/http
git commit -m "feat: express app with health and readiness checks"
```

---

## Phase 1 Definition of Done

- [ ] `docker compose up -d` yields a healthy `pgvector/pgvector:pg17` container with `rag` and `rag_test` databases
- [ ] `bun run migrate` applies `0001_init.sql`; a second run reports "already up to date"
- [ ] `bun test` passes with zero failures
- [ ] Integration tests skip cleanly when `TEST_DATABASE_URL` is unset, and run when it is set
- [ ] The database itself rejects a cross-cohort class and a second active transcript per class
- [ ] `bun run dev:api` serves `/health` and `/ready`, and `/ready` returns 503 when the database is unreachable
- [ ] No error response contains a stack trace, a connection string, or a provider message
- [ ] Removing `OPENAI_API_KEY` from `.env` makes the server refuse to boot with a message naming that variable

**Next:** the Phase 2 plan (`2026-09-08-phase-2-deterministic-core.md`) covers the SRT/VTT parsers, sentence segmenter, reconstruction, tokenizer, chunker, and deterministic chunk keys — written after Phase 1 lands, so it can reflect what Phase 1 actually produced.
