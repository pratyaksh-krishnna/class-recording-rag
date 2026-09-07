# Transcript RAG for Course Recordings — Design Spec

**Date:** 2026-09-08
**Status:** Approved for implementation planning
**Scope:** V1 — transcript-only retrieval. No recording playback (V2).

---

## 1. Final Architecture

Two independent pipelines share one PostgreSQL database. Nothing in the
synchronous path calls the embedding API; nothing in the asynchronous path
serves user traffic.

### 1.1 Ingestion (asynchronous, Inngest)

```
POST /api/transcripts (multipart)  ─┐
bun run seed:transcripts           ─┴─→ event: transcript.ingest.requested
                                             │
  step 1  resolve + hash        → transcripts row, UNIQUE(class_id, content_hash)
  step 2  parse SRT/VTT         → normalized cues (speaker captured, unused in V1)
  step 3  reconstruct sentences → char-range→cue map → per-sentence start/end ms
  step 4  deterministic chunks  → chunk_key, token_count, start_ms, end_ms
  step 5  persist chunks        → INSERT ... ON CONFLICT (chunk_key) DO NOTHING
  step 6  embed missing         → batched; UPDATE ... WHERE embedding IS NULL
  step 7  finalize run          → ingestion_runs.status = completed
```

Idempotency is enforced by database constraints, not application logic. Every
step is individually retryable because each is a pure function of durable state.

### 1.2 Retrieval (synchronous, single HTTP request)

```
POST /api/chat  { question, conversationId? }  + x-user-id / x-cohort-id
    │
    ├─ 1. conversation contextualization  (LLM, strict schema; SKIPPED on first turn)
    ├─ 2. query planner                   (LLM, strict schema)
    │        → 1–6 queries: contextualized [+rewrite] [+step-back] [+ ≤3 subqueries]
    ├─ 3. parallel hybrid retrieval       (2 × N SQL queries, all concurrent)
    │        per query: vector top-10  AND  keyword top-10
    │        cohort_id is inside every WHERE clause
    ├─ 4. Reciprocal Rank Fusion          Σ 1/(k + rank),  k=60, rank from 1
    ├─ 5. exact chunk-ID deduplication    (and nothing else)
    ├─ 6. context construction            RRF order, stop at 8k tokens, SOURCE_N labels
    ├─ 7. evidence assessment             (LLM, strict schema)
    │        → sufficient | partial | insufficient | conflicting
    ├─ 8. answer generation               (LLM; prompt selected by verdict)
    ├─ 9. citation validation             every [SOURCE_N] must exist in evidence
    │        → invalid ⇒ one regeneration ⇒ still invalid ⇒ strip + downgrade + log
    └─ 10. persist messages + citations → structured JSON response
```

### 1.3 Data hierarchy

```
cohorts ─< modules ─< classes ─< transcripts ─< chunks
cohorts ─< conversations ─< messages ─< message_citations >─ chunks
ingestion_runs (observability)
```

---

## 2. Decisions Not Specified in the Requirements

Every row below was an open question. Each was decided explicitly.

| # | Question | Decision | Reasoning |
|---|---|---|---|
| 1 | Runtime, given CLAUDE.md mandates Bun and the brief mandates Express | **Bun runtime + Express HTTP layer** | Bun runs Express unmodified. Satisfies both the project convention (`bun install`, `bun test`, auto-`.env`) and the brief's stated stack. Express also keeps the app portable to plain Node. |
| 2 | How to call "GPT-5.6 Luna" | **`gpt-5.6-luna` via the stock `openai` SDK, Responses API** | Verified against OpenAI docs: the model is native OpenAI at `https://api.openai.com/v1`, supports strict `json_schema` structured outputs, and exposes `reasoning.effort`. No custom adapter needed. |
| 3 | Repository layout | **Monorepo: `apps/api`, `apps/web`, `packages/shared`** | The request/response contract must not drift between backend and frontend. One workspace, one install, one type source. |
| 4 | Postgres provisioning | **`docker-compose` with `pgvector/pgvector:pg17`** | Zero-setup pgvector. Migrations remain plain SQL so any hosted Postgres also works. |
| 5 | Database access layer | **Drizzle for schema + CRUD; `sql` templates for retrieval; hand-written SQL migrations** | Drizzle gives typed CRUD and a real `vector()` column type. `drizzle-kit` cannot generate `CREATE EXTENSION`, HNSW parameters, generated `tsvector` columns, or partial unique indexes correctly, so migrations stay hand-written and reviewable. |
| 6 | Every class has both `.srt` and `.vtt` | **Prefer `.vtt`, fall back to `.srt`; exactly one active transcript per class** | Ingesting both would create near-identical duplicate chunks competing in retrieval — and post-RRF dedup is exact-chunk-ID only, so it could not repair that. VTT is the richer format and carries voice tags for V2 speaker metadata. |
| 7 | No cohort/module/class metadata exists | **Folder scan → editable `seed.manifest.json` → DB** | Class titles appear verbatim in evidence cards. Module 17's folders are literally `chapter-1_epm`, which would make useless citations. The manifest is the human review gate, and it is re-runnable and diffable. |
| 8 | `module 1 hc` | **Module 18, named "Bonus Content"** | Confirmed by the user. Its two files are supplementary, not curriculum. |
| 9 | Cohort identity | **name "mobile dev cohort", slug `mobile-dev-cohort`** | Confirmed by the user. |
| 10 | Sentence segmentation | **Custom rule-based segmenter behind a `SentenceSegmenter` interface** | Chunk IDs derive from sentence boundaries, so segmentation must be stable *forever*. `Intl.Segmenter` depends on the runtime's ICU version, which is not pinned by the lockfile — an ICU bump could silently change chunk identity and break idempotency. A local rule set is pinned, tunable to auto-captioned speech, and unit-testable against the real corpus. |
| 11 | **`js-tiktoken`, `o200k_base` encoding; name stored per chunk** | `o200k_base` is the encoding used by the recent GPT-4o/GPT-5-generation models, so context budgeting is close to exact. Chunks target ~500 tokens, far below the embedding model's 8192-token input limit, so one tokenizer serves both purposes. `TOKENIZER_ENCODING` is configurable and the encoding name is stored per chunk, so if `gpt-5.6-luna` turns out to use a different encoding it is a config change plus a versioned reindex, not a redesign. |
| 12 | Embedding dimensionality | **1536 (native), env-configurable** | The corpus is ~3–4k chunks (~24 MB of vectors). Matryoshka reduction trades accuracy for a storage and latency problem this dataset does not have. 1536 is also comfortably under pgvector's 2000-dimension HNSW limit. |
| 13 | Chat response shape | **Single validated JSON response** | Citation validation requires inspecting the complete answer before the user sees it. Streamed tokens cannot be un-sent, so streaming would structurally weaken the anti-fabrication guarantee. The frontend shows staged pipeline progress instead. |
| 14 | User / cohort identity | **`x-user-id` + `x-cohort-id` headers via one `requireCohortContext` middleware** | Single choke point, single future swap-point for real auth. Explicitly documented as a spoofable placeholder. |
| 15 | Evidence context budget | **8,000 tokens (~16 chunks)** | Enough to synthesize across 8+ classes, which multi-class synthesis requires. Large enough to avoid truncating real evidence, small enough to avoid attention dilution across marginal chunks, and to keep cost and latency predictable. The model's ~1M window is not the constraint; answer quality is. |
| 16 | Conversation history budget | **1,500 tokens, most-recent-first** | Roughly the last 3–4 turns. Enough for pronoun resolution and tone continuity, bounded so history can never crowd out evidence. |
| 17 | General-knowledge fallback | **Allowed by default, visually separated, `ALLOW_GENERAL_KNOWLEDGE_FALLBACK` toggle** | Matches the brief ("the system MAY provide a general knowledge answer"). The toggle allows a strict course-only deployment later without a code change. |
| 18 | Timestamp representation | **`start_ms`/`end_ms` integers in DB; API returns display strings *and* ms** | Integer ms is exact and sortable with no float drift. Returning both means V2's "Jump to recording" is a pure frontend change — the ms fields exist precisely so the retrieval architecture never has to change. |
| 19 | Keyword search implementation | **`websearch_to_tsquery('english', …)` ranked by `ts_rank_cd`, GIN index on a generated `tsvector` column** | `websearch_to_tsquery` never throws on arbitrary user input (unlike `to_tsquery`) and understands quoted phrases and `-exclusion`. `ts_rank_cd` weights term *proximity*, which is the correct signal for passage retrieval — a chunk where the query terms appear together outranks one where they are scattered. The generated column keeps the index always consistent with `text`. |
| 20 | Vector index parameters | **HNSW, `vector_cosine_ops`, `m=16`, `ef_construction=64`, `ef_search=64`** | pgvector's documented balanced defaults. At ~4k vectors any index is fast; these values scale to millions without re-tuning. All three are env-configurable and documented. Cosine matches OpenAI embeddings, which are normalized. |
| 21 | Chunk storage vs. re-embedding | **`embedding` stays on `chunks`; `embedding_model` participates in the unique key** | The brief specifies `embedding` on the chunks table. A separate `chunk_embeddings` join table would avoid duplicating text across embedding models, but costs a join on the hot path to save ~4 MB at this scale. Rejected as a premature optimization; noted here as the migration path if the corpus grows by orders of magnitude. |
| 22 | Chunk persistence vs. embedding order | **Persist chunks first with `embedding NULL`, then backfill embeddings** | Makes partial ingestion resumable and observable: a retry re-embeds only `WHERE embedding IS NULL`. Retrieval filters `embedding IS NOT NULL`, so half-embedded transcripts never leak into results. |
| 23 | Ingestion entry points | **HTTP upload endpoint AND local CLI seeder, both emitting the same event** | The endpoint is the real product API; the CLI bulk-loads the 87 local files. Because both converge on one Inngest workflow, the CLI exercises production code. |
| 24 | Reasoning effort per LLM step | **contextualizer `low`, planner `low`, judge `medium`, answer `medium`** | Contextualization and planning are short structured transformations. Judging and answering require actual reading of evidence. All four are env-configurable. |
| 25 | Frontend toolchain | **Vite + React + TypeScript + Tailwind CSS** | Standard, fast, and Tailwind makes the four-state grounding colour system consistent across badges, cards, and answer blocks. |
| 26 | Testing depth | **Unit everywhere + integration against the real Dockerised Postgres** | pgvector ranking, FTS ranking, and constraint-driven idempotency are the highest-risk components and cannot be meaningfully mocked. |
| 27 | Evaluation authorship | **~25 questions drafted from the real corpus, reviewed and corrected by the user** | Ground truth is the one part only a human who knows the course can validate. Self-graded synthetic ground truth would be a meaningless signal. |

### 2.1 Explicitly rejected

Elasticsearch, Pinecone, Weaviate, Kafka, any second vector store, neural
reranking, semantic deduplication, post-RRF diversity filtering, LLM-driven
chunk boundaries, per-user ACLs, numeric confidence scores, video processing.

---

## 3. Database Schema

Migrations are numbered, hand-written `.sql` files under
`apps/api/migrations/`, applied by a small runner that records applied
filenames in `schema_migrations`. Drizzle's schema definitions in
`apps/api/src/db/schema.ts` mirror these tables for typed CRUD.

### 3.1 `0001_init.sql`

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
CREATE INDEX classes_cohort_idx        ON classes (cohort_id);
CREATE INDEX classes_module_pos_idx    ON classes (module_id, position);

-- ─────────────────────────────────────────── transcripts

CREATE TABLE transcripts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id     uuid        NOT NULL,
  module_id     uuid        NOT NULL,
  class_id      uuid        NOT NULL,
  format        text        NOT NULL CHECK (format IN ('srt','vtt')),
  source_uri    text        NOT NULL,
  content_hash  text        NOT NULL,          -- sha256 hex of raw bytes
  byte_size     integer     NOT NULL,
  language      text        NOT NULL DEFAULT 'en',
  cue_count     integer,
  duration_ms   integer,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- re-uploading identical bytes resolves to the SAME row: ingestion idempotency anchor
  UNIQUE (class_id, content_hash),
  UNIQUE (id, cohort_id),
  FOREIGN KEY (class_id, cohort_id)
    REFERENCES classes (id, cohort_id) ON DELETE CASCADE
);
-- at most one active transcript per class
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

-- the exact predicate every retrieval query filters on
CREATE INDEX chunks_scope_idx
  ON chunks (cohort_id, chunking_version, embedding_model)
  WHERE embedding IS NOT NULL;

CREATE INDEX chunks_class_order_idx ON chunks (class_id, chunk_index);

-- drives the embedding backfill step
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
  source_id  text    NOT NULL,                    -- 'SOURCE_1'
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

### 3.2 Why the composite foreign keys

`chunks.cohort_id` is denormalised so retrieval filters on one column with no
joins. That denormalisation is normally a correctness risk. The composite
`FOREIGN KEY (class_id, cohort_id) REFERENCES classes (id, cohort_id)` removes
it: a chunk whose `cohort_id` disagrees with its class's cohort cannot be
inserted. Cross-cohort leakage becomes unrepresentable in the schema rather
than merely unlikely in the code.

### 3.3 Version coexistence

Retrieval always filters on the *active* `chunking_version` and
`embedding_model` from configuration. A reindex writes rows with a new version
alongside the old ones; both sets coexist and serve nothing until an
environment variable switches over. No blind rewrite, no downtime, and the old
rows remain as an instant rollback.

---

## 4. Project Structure

```
rag-class-recordings/
├── docker-compose.yml                  # pgvector/pgvector:pg17
├── package.json                        # Bun workspaces root
├── packages/shared/
│   └── src/
│       ├── contracts.ts                # ChatRequest/ChatResponse/Source/GroundingStatus
│       ├── grounding.ts                # the 4-state union + guards
│       └── index.ts
├── apps/api/
│   ├── migrations/
│   │   ├── 0001_init.sql
│   │   └── run.ts                      # migration runner + schema_migrations
│   ├── evals/
│   │   ├── dataset.yaml                # the eval questions (user-reviewed)
│   │   ├── run.ts                      # harness
│   │   └── metrics.ts                  # recall@k, MRR, nDCG
│   ├── scripts/
│   │   ├── build-manifest.ts           # recordings/ → seed.manifest.json
│   │   └── seed-transcripts.ts         # manifest → DB rows + ingest events
│   └── src/
│       ├── index.ts                    # Express app bootstrap
│       ├── config/
│       │   ├── env.ts                  # Zod-validated process.env, fails fast
│       │   └── rag.ts                  # chunking / retrieval / RRF / budget constants
│       ├── db/
│       │   ├── client.ts               # pg Pool + Drizzle instance
│       │   ├── schema.ts               # Drizzle table definitions
│       │   └── repositories/
│       │       ├── cohorts.repo.ts
│       │       ├── classes.repo.ts
│       │       ├── transcripts.repo.ts
│       │       ├── chunks.repo.ts      # bulk upsert + hydrate-by-id-in-order
│       │       ├── conversations.repo.ts
│       │       └── ingestionRuns.repo.ts
│       ├── http/
│       │   ├── routes/
│       │   │   ├── chat.routes.ts
│       │   │   ├── transcripts.routes.ts
│       │   │   ├── conversations.routes.ts
│       │   │   ├── catalog.routes.ts
│       │   │   └── health.routes.ts
│       │   ├── controllers/            # thin: validate → call service → shape response
│       │   ├── middleware/
│       │   │   ├── requireCohortContext.ts
│       │   │   ├── requestContext.ts   # requestId + AsyncLocalStorage
│       │   │   ├── upload.ts           # multer: memory, 5 MB, .srt/.vtt only
│       │   │   └── errorHandler.ts     # AppError → safe JSON, never a stack trace
│       │   └── validation/             # Zod schemas per endpoint
│       ├── ingestion/
│       │   ├── parsers/
│       │   │   ├── types.ts            # NormalizedCue
│       │   │   ├── srt.parser.ts
│       │   │   ├── vtt.parser.ts
│       │   │   └── index.ts            # format detection + dispatch
│       │   ├── sentences/
│       │   │   ├── segmenter.ts        # SentenceSegmenter interface
│       │   │   ├── ruleBased.segmenter.ts
│       │   │   ├── abbreviations.ts
│       │   │   └── reconstruct.ts      # cues → sentences with timestamps
│       │   ├── chunking/
│       │   │   ├── chunker.ts          # the rule engine
│       │   │   └── chunkKey.ts         # deterministic identity
│       │   └── tokenizer/
│       │       └── tokenizer.ts        # Tokenizer interface + js-tiktoken impl
│       ├── inngest/
│       │   ├── client.ts
│       │   ├── events.ts               # typed event schemas
│       │   └── functions/
│       │       ├── ingestTranscript.ts
│       │       └── reindexTranscript.ts
│       ├── providers/
│       │   ├── embedding/
│       │   │   ├── provider.ts         # EmbeddingProvider interface
│       │   │   ├── openai.embedding.ts
│       │   │   └── deterministic.mock.ts
│       │   └── llm/
│       │       ├── provider.ts         # LLMProvider interface
│       │       ├── openai.llm.ts       # Responses API + strict json_schema
│       │       └── scripted.mock.ts
│       ├── rag/
│       │   ├── orchestrator.ts         # the 10-step pipeline, and only that
│       │   ├── contextualizer.ts
│       │   ├── planner.ts
│       │   ├── retrieval/
│       │   │   ├── vector.retriever.ts
│       │   │   ├── keyword.retriever.ts
│       │   │   └── hybrid.ts           # parallel fan-out
│       │   ├── fusion/rrf.ts           # pure function
│       │   ├── context/
│       │   │   ├── dedupe.ts
│       │   │   └── contextBuilder.ts
│       │   ├── evidence/judge.ts
│       │   ├── generation/
│       │   │   ├── answerGenerator.ts
│       │   │   └── citationValidator.ts
│       │   ├── conversation/history.ts # token-budgeted history selection
│       │   └── schemas/                # Zod + JSON Schema for every LLM step
│       ├── observability/
│       │   ├── logger.ts               # pino, structured
│       │   └── trace.ts                # span timing helpers
│       └── errors/AppError.ts
├── apps/web/
│   └── src/
│       ├── main.tsx
│       ├── api/client.ts               # typed against packages/shared
│       ├── hooks/{useChat,useConversation}.ts
│       └── components/
│           ├── ChatView.tsx
│           ├── MessageList.tsx
│           ├── AnswerWithCitations.tsx  # renders [SOURCE_N] as clickable pills
│           ├── GroundingBadge.tsx
│           ├── GeneralKnowledgeBlock.tsx
│           ├── EvidenceCard.tsx
│           ├── EvidenceCardList.tsx
│           ├── PipelineProgress.tsx
│           └── Composer.tsx
└── tests/                              # bun test; unit/ and integration/
```

**Rule enforced by structure:** `orchestrator.ts` is the only file that knows
the pipeline's shape. Controllers call it and shape HTTP. No RAG logic lives in
a controller.

---

## 5. Ingestion Architecture

### 5.1 Parsing

Both parsers emit the same `NormalizedCue`:

```ts
interface NormalizedCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;        // cleaned
  speaker: string | null;  // captured for V2; unused in V1 retrieval
}
```

Cleaning removes, deterministically: VTT `NOTE` blocks, `WEBVTT` and `Kind:`/
`Language:` headers, cue settings (`align:start position:0%`), inline tags
(`<v Name>`, `<b>`, `<00:05:01.000>`), HTML entities (`&amp;` → `&`), and a
leading `Speaker:` prefix — the last two being extracted into `speaker` rather
than discarded. Both `HH:MM:SS,mmm` (SRT) and `HH:MM:SS.mmm` / `MM:SS.mmm`
(VTT) timestamp forms are supported.

Format is chosen by extension, then verified by content sniffing (`WEBVTT`
header vs. numeric cue index). A mismatch is a permanent error, not a retry.

### 5.2 Sentence reconstruction

Subtitle cues split sentences arbitrarily. Reconstruction:

1. Concatenate all cue texts with a single space, recording for each cue the
   `[startChar, endChar)` range it occupies in the concatenated string.
2. Run the `SentenceSegmenter` over the full concatenated text.
3. For each sentence's `[startChar, endChar)`, find every overlapping cue.
4. `sentence.startMs` = first overlapping cue's `startMs`;
   `sentence.endMs` = last overlapping cue's `endMs`.
5. `sentence.gapAfterMs` = next sentence's `startMs` − this sentence's `endMs`.

This is what makes a sentence spanning three cues carry the start of the first
and the end of the last, exactly as required.

### 5.3 Sentence segmentation rules

The rule-based segmenter proposes a boundary after `[.!?…]+` followed by
whitespace, then **rejects** the boundary when any of these hold:

- the preceding token is a known abbreviation (`e.g.`, `i.e.`, `Dr.`, `vs.`,
  `etc.`, `Mr.`, `Fig.`, `No.`, `approx.`, …) — list in `abbreviations.ts`
- the period sits inside a decimal (`3.5`), a version (`v4.2`), or an ordinal
- it is an ellipsis followed by a lowercase continuation
- the next non-space character is not uppercase, a digit, or an opening quote
- the sentence so far is below a minimum character floor (guards `A. B. C.`)

A hard cap splits any "sentence" exceeding a configured character ceiling at
the last clause boundary, so a transcript with no punctuation at all cannot
produce one unbounded sentence.

### 5.4 Deterministic chunk identity

```
chunk_key = "{cohortSlug}:{moduleSlug}:{classSlug}:{contentHash[0:12]}:{chunkingVersion}:{embeddingModel}:{chunkIndex padded to 4}"

e.g. mobile-dev-cohort:module-7:2-understanding-the-gyroscope:9f3a1c7d2e04:v1:text-embedding-3-small:0007
```

Human-readable on purpose — a chunk ID in a log tells you the class, the
transcript version, and the position without a database lookup. The UUID `id`
remains the primary key for foreign keys; `chunk_key` carries identity and the
`UNIQUE` constraint that makes re-ingestion a no-op.

Re-ingesting identical bytes produces byte-identical `chunk_key`s, so
`ON CONFLICT (chunk_key) DO NOTHING` makes the whole workflow idempotent at the
database level.

---

## 6. Deterministic Chunking

Configuration (`config/rag.ts`, all env-overridable):

```ts
export const chunkingConfig = {
  version:          env.CHUNKING_VERSION,        // 'v1'
  targetTokens:     env.CHUNK_TARGET_TOKENS,     // 500
  minTokens:        env.CHUNK_MIN_TOKENS,        // 350
  maxTokens:        env.CHUNK_MAX_TOKENS,        // 650
  overlapRatio:     env.CHUNK_OVERLAP_RATIO,     // 0.125  (12.5%, mid of 10–15%)
  gapPreferredMs:   env.CHUNK_GAP_PREFERRED_MS,  // 2000
} as const;
```

### 6.1 The rules, stated explicitly

Written as a documented ordered rule set, not as buried heuristics:

| Rule | Kind | Statement |
|---|---|---|
| **R1** | Hard, structural | Chunking operates on exactly one transcript, which belongs to exactly one class in exactly one module. Class and module boundaries are therefore *unrepresentable* rather than checked — there is no code path that could cross one. |
| **R2** | Hard | Sentences are atomic. A chunk boundary is always a sentence boundary. |
| **R3** | Hard | A single sentence exceeding `maxTokens` becomes its own chunk, kept whole. Any open chunk is flushed first. |
| **R4** | Soft, preferred | If the current chunk has reached `minTokens` and the gap after the current sentence is ≥ `gapPreferredMs`, flush here. This is the preferred boundary. |
| **R5** | Soft | If adding the next sentence would exceed `maxTokens` **and** the current chunk has reached `minTokens`, flush before adding. If the chunk has *not* reached `minTokens`, add anyway and exceed the soft maximum — a slightly oversized chunk beats a tiny one. |
| **R6** | Soft | If the current chunk has reached `targetTokens` and no preferred gap boundary applied, flush. |
| **R7** | Overlap | Each new chunk is seeded with trailing sentences of the previous chunk, taken from the end while cumulative tokens ≤ `overlapRatio × previousChunkTokens`, and always capped at `previousSentenceCount − 1` so forward progress is guaranteed. Sentences are never split to create overlap. |
| **R8** | Tail | The final chunk of a transcript may fall below `minTokens`. It is not merged backwards and not padded. |

R4 is what keeps gaps a *preference*: it can only fire once `minTokens` is
reached, so a 2-second pause early in a chunk never produces a tiny chunk.

### 6.2 Chunk timestamps

`chunk.start_ms` = first sentence's `startMs`.
`chunk.end_ms` = last sentence's `endMs`.
Because overlap sentences are real sentences from the previous chunk,
consecutive chunks legitimately overlap in time. That is correct and expected.

### 6.3 Interface

```ts
interface ChunkingResult {
  chunks: PreparedChunk[];
  stats: { sentenceCount: number; oversizedSentences: number; gapBoundariesUsed: number };
}

function chunkSentences(
  sentences: ReconstructedSentence[],
  ctx: { cohortSlug: string; moduleSlug: string; classSlug: string;
         contentHash: string; embeddingModel: string },
  config: ChunkingConfig,
  tokenizer: Tokenizer,
): ChunkingResult;
```

Pure and synchronous — no I/O, no clock, no randomness. Identical input always
yields identical output, which is what makes the whole idempotency story hold.

---

## 7. Inngest Workflows

### 7.1 Events

```ts
type Events = {
  'transcript.ingest.requested': {
    data: { transcriptId: string; classId: string; cohortId: string;
            sourceUri: string; requestedBy: string };
  };
  'transcript.reindex.requested': {
    data: { transcriptId: string; chunkingVersion: string; embeddingModel: string };
  };
};
```

### 7.2 `ingest-transcript`

```ts
inngest.createFunction(
  { id: 'ingest-transcript',
    retries: 3,
    concurrency: { limit: env.INGEST_CONCURRENCY },              // default 4
    idempotency: 'event.data.transcriptId' },
  { event: 'transcript.ingest.requested' },
  async ({ event, step, logger }) => { /* steps below */ },
);
```

| Step | Work | Retry behaviour |
|---|---|---|
| `load-transcript` | Read bytes, verify sha256 matches `content_hash`, mark run `parsing` | Retryable (I/O) |
| `parse` | Detect format, parse cues, reject empty transcript | `NonRetriableError` on unsupported format / empty / unparseable |
| `chunk` | Reconstruct sentences, run chunker | `NonRetriableError` — pure function, a retry cannot help |
| `persist-chunks` | Bulk `INSERT … ON CONFLICT (chunk_key) DO NOTHING` | Retryable; safe because the conflict clause makes it a no-op |
| `embed` | Loop batches of `WHERE embedding IS NULL`, call provider, `UPDATE` | Retryable; each retry sees fewer pending rows, so progress is never lost |
| `finalize` | `ingestion_runs.status = completed` with counts | Retryable |

Permanent failures (bad format, empty file, hash mismatch) throw
`NonRetriableError` so Inngest does not burn retries on something a retry
cannot fix. Transient failures (network, rate limit, database) use ordinary
retries with Inngest's backoff.

Chat never enters Inngest. Retrieval is synchronous with internal parallelism.

### 7.3 Batch seeding

`bun run seed:transcripts` reads `seed.manifest.json`, upserts cohort/modules/
classes/transcripts, then emits one `transcript.ingest.requested` per class.
Fan-out and concurrency control belong to Inngest, not the script.

---

## 8. Conversation Contextualization

**Skipped entirely when the conversation has no prior messages** — a first
question is already standalone, and spending an LLM call to discover that is
waste.

Input: the token-budgeted history (§12) plus the current question. Never the
whole conversation, and the history is never embedded as the search query.

```ts
const ContextualizedQuerySchema = z.object({
  standaloneQuery: z.string().min(3).max(400),
  usedHistory: z.boolean(),
  resolvedReferences: z.array(z.string()).max(5),  // e.g. ["it" → "normalization"]
});
```

`reasoning.effort: low`. On any failure — timeout, schema violation, refusal —
the fallback is the raw user question. Degraded retrieval beats a failed
request.

---

## 9. Query Planner

`reasoning.effort: low`. Receives the standalone query and the budgeted
history. **Deliberately not given the module/class catalogue** — its job is
query formulation, not course navigation, and feeding it 87 class titles would
bias it toward titles that happen to match wording.

```ts
const QueryPlanSchema = z.object({
  contextualizedQuery: z.string().min(3).max(400),
  rewrittenQuery:      z.string().min(3).max(400).nullable(),
  stepBackQuery:       z.string().min(3).max(400).nullable(),
  subQueries:          z.array(z.string().min(3).max(400)).max(3),
  rationale:           z.string().max(500),   // logged, never returned to the user
});
```

The prompt instructs the planner to emit `null` and `[]` for simple questions.
Nothing forces a query through every transformation.

**Normalization before retrieval** (planner output is untrusted input):

1. Trim; drop empty and whitespace-only strings.
2. Case-insensitively deduplicate against `contextualizedQuery` and each other.
3. Truncate any query over 400 characters.
4. Cap subqueries at 3, and the total query set at `MAX_QUERIES` (6 = contextualized + rewrite + step-back + 3 subqueries).
5. If validation fails outright, fall back to a single-query plan containing
   only the contextualized query. Retrieval always has something to run.

---

## 10. Hybrid Retrieval

For each planned query, vector and keyword retrieval run **concurrently**, and
all queries run concurrently with each other — a single `Promise.all` over
`2 × N` database calls. Embeddings for all N queries are generated in **one**
batched call before fan-out.

`cohort_id` is a required argument on both retriever interfaces, so a
cohort-less search does not typecheck.

### 10.1 Vector retrieval

```sql
SELECT id, chunk_key, class_id, module_id, chunk_index,
       1 - (embedding <=> $1::vector) AS score
FROM chunks
WHERE cohort_id        = $2
  AND chunking_version = $3
  AND embedding_model  = $4
  AND embedding IS NOT NULL
ORDER BY embedding <=> $1::vector
LIMIT $5;                                        -- 10
```

`SET LOCAL hnsw.ef_search = $HNSW_EF_SEARCH` is issued on the connection first.
The cohort predicate is inside the query, never a post-filter.

### 10.2 Keyword retrieval

```sql
SELECT c.id, c.chunk_key, c.class_id, c.module_id, c.chunk_index,
       ts_rank_cd(c.tsv, q.query) AS score
FROM chunks c, websearch_to_tsquery('english', $1) AS q(query)
WHERE c.cohort_id        = $2
  AND c.chunking_version = $3
  AND c.embedding_model  = $4
  AND c.embedding IS NOT NULL
  AND c.tsv @@ q.query
ORDER BY score DESC, c.chunk_key ASC              -- deterministic tie-break
LIMIT $5;                                         -- 10
```

`websearch_to_tsquery` cannot raise a syntax error on arbitrary user text, so
no user input can break the query. An empty tsquery simply returns no rows,
which RRF handles as an empty list.

### 10.3 Note on filtered HNSW

pgvector applies the `WHERE` filter after the index scan. With a single cohort
of ~4k chunks this is irrelevant. If cohort count grows such that one cohort is
a small fraction of the table, the documented remedy is a partial HNSW index
per active `(chunking_version, embedding_model)` pair, or raising `ef_search`.
Recorded here so the tradeoff is a known dial, not a surprise.

---

## 11. Reciprocal Rank Fusion

A pure function. No I/O, no model, fully unit-testable.

```ts
interface RankedList {
  id: string;                       // 'q2:vector' — for diagnostics
  queryLabel: string;               // 'step_back' | 'sub_query_1' | ...
  retriever: 'vector' | 'keyword';
  chunkIds: string[];               // rank order; rank = index + 1
}

interface FusedChunk {
  chunkId: string;
  rrfScore: number;
  bestRank: number;
  contributions: { listId: string; rank: number }[];
}

function fuseRRF(lists: RankedList[], k: number): FusedChunk[];
```

Score: `RRF(d) = Σ 1 / (k + rank(d))`, ranks starting at **1**, `k` from
`config.rrf.k` (default 60) — read from configuration in exactly one place.

**Every** produced list participates: contextualized-vector, contextualized-
keyword, rewritten-vector, rewritten-keyword, step-back-vector, step-back-
keyword, and each subquery's vector and keyword lists.

Sort: `rrfScore` descending, then `bestRank` ascending, then `chunkId`
ascending. The final tie-break makes output deterministic for identical input.

`contributions` is kept for observability — it answers "which query found
this?" — and is never used to filter.

---

## 12. Post-RRF Handling and Context Construction

### 12.1 Deduplication — exact chunk IDs only

Because `fuseRRF` keys by `chunkId`, duplicates are already merged. A separate,
explicitly-named `dedupeExactChunkIds` step still exists so the requirement is
visible in the code and directly testable.

**Nothing else is removed.** No adjacency filtering, no per-class caps, no
diversity, no semantic dedup, no reranking. If chunks 10–14 of one class all
rank highly, all five reach the context — which is exactly right when the
instructor explained one topic across five consecutive minutes.

### 12.2 Context builder

Sole responsibilities: ordering, token budgeting, formatting, metadata
attachment.

1. Hydrate full chunk rows for the fused IDs in **one** query, preserving RRF
   order (`ORDER BY array_position($1::uuid[], id)`), joined to class and
   module names.
2. Walk in RRF order. For each chunk, cost = `token_count` + the header's token
   cost. Stop as soon as adding the next chunk would exceed
   `CONTEXT_TOKEN_BUDGET` (8000).
3. Assign `SOURCE_1 … SOURCE_N` **in RRF order**, so source numbering reflects
   retrieval ranking.

Rendered block per source:

```
[SOURCE_3]
module: Module 7 — Device Sensors (id: 4f2c…)
class: 2. Understanding the Gyroscope (id: 8a11…)
timestamp: 00:12:31 – 00:14:42
transcript: 6b7e…
---
So this sensor measures how quickly the device is rotating…
```

The builder never reorders and never drops a chunk for any reason except the
budget.

### 12.3 The evidence map

```ts
type EvidenceMap = Map<string, {          // 'SOURCE_3' → metadata
  chunkId, transcriptId, moduleId, moduleName, classId, className,
  startMs, endMs, startTime, endTime, text,
}>;
```

This map is the **single source of truth** for citation metadata. The LLM sees
source IDs and text; every value returned to the user is read back out of this
map, which was itself built from database rows. The model has no path by which
it could contribute a timestamp, module name, class name, or chunk ID.

---

## 13. Evidence Assessment

A separate model call before generation, with `reasoning.effort: medium`. It
exists because retrieval scores measure similarity, not sufficiency — a chunk
can be the most similar text in the course and still fail to answer the
question — and because a model grading its own answer is not an independent
check.

```ts
const EvidenceAssessmentSchema = z.object({
  verdict: z.enum(['sufficient', 'partial', 'insufficient', 'conflicting']),
  rationale: z.string().max(800),
  supportingSourceIds:  z.array(z.string()).max(20),
  conflictingSourceIds: z.array(z.string()).max(20),
  missingInformation:   z.array(z.string().max(200)).max(5),
});
```

Post-validation: every returned source ID is checked against the evidence map
and silently dropped if absent — model-produced identifiers are never trusted.
`rationale` is logged for observability and never shown to the user.

Fallback on judge failure: if the evidence set is non-empty, proceed as
`partial` (conservative — it forces explicit labelling of anything not
supported); if empty, `insufficient`. The request never fails because the judge
did.

---

## 14. Answer Generation and Grounding

`reasoning.effort: medium`. One prompt template per verdict, sharing a common
grounding preamble.

| Verdict | Instruction | Resulting status |
|---|---|---|
| `sufficient` | Answer from evidence only. Cite every claim. | `course_grounded` |
| `partial` | Answer the supported part from evidence with citations; put anything beyond it in a clearly marked general-knowledge section. | `partially_grounded` |
| `insufficient` | State plainly that the transcripts do not cover this. Then, if the fallback is enabled, give a clearly separated general-knowledge answer. Still surface the closest course evidence. | `general_knowledge` |
| `conflicting` | Do not resolve the disagreement silently. Describe each account, cite each source. May explain a resolution *only* if the evidence itself supplies it. | `conflicting` |

Shared preamble rules: paraphrase by default; short direct quotes only for
precise definitions; never reproduce long transcript passages; never invent
module names, class names, timestamps, or chunk IDs; never present model
knowledge as something taught in the course; cite as `[SOURCE_N]` using only
supplied IDs.

```ts
const AnswerSchema = z.object({
  answer: z.string().min(1).max(8000),
  citedSourceIds: z.array(z.string()).max(20),
  usedGeneralKnowledge: z.boolean(),
});
```

### 14.1 Citation validation — the safety rule

1. Extract every `[SOURCE_\d+]` marker from the answer text by regex. The
   markers in the prose are authoritative, not the model's `citedSourceIds`
   field, which is cross-checked against them.
2. Every marker must exist in the evidence map.
3. If any marker is invalid: **one** regeneration attempt, with a corrective
   message naming the valid IDs.
4. If it is still invalid: strip the invalid markers from the text and log a
   `citation.fabricated` event with the offending IDs. The status is then
   recomputed from what survives — if at least one valid citation remains the
   verdict-derived status stands; if none remains it becomes
   `general_knowledge`.
5. `sources[]` is then built **only** from validated markers, reading metadata
   out of the evidence map. Sources are returned in first-appearance order in
   the answer.

Additional consistency guard: if the judge said `sufficient` but the validated
answer contains **zero** citations, the status is downgraded to
`general_knowledge` and the anomaly is logged. A confident-sounding uncited
answer must not be presented as course-grounded.

---

## 15. Conversation Memory

```ts
function selectHistory(messages: Message[], budgetTokens: number): Message[];
```

Walks backwards from the most recent message, accumulating token counts, and
stops at `CONVERSATION_HISTORY_TOKEN_BUDGET` (1500). Always keeps whole
user/assistant pairs so the model never sees an answer without its question.
The oldest partial pair is dropped rather than truncated mid-message.

The same budgeted history feeds the contextualizer and the answer generator.
Neither ever receives the full conversation. Assistant messages are passed as
plain text without their `[SOURCE_N]` markers, so stale source numbering from a
previous turn cannot contaminate the current turn's numbering.

---

## 16. API Contracts

All types live in `packages/shared/src/contracts.ts` and are imported by both
apps, so the contract cannot drift.

### 16.1 `POST /api/chat`

```
Headers: x-user-id: <string>   x-cohort-id: <uuid>   (required)
```

```ts
interface ChatRequest {
  question: string;            // 1–2000 chars
  conversationId?: string;     // uuid; omitted starts a new conversation
}

interface ChatResponse {
  conversationId: string;
  messageId: string;
  answer: string;
  groundingStatus: 'course_grounded' | 'partially_grounded'
                 | 'general_knowledge' | 'conflicting';
  sources: Source[];
  diagnostics?: Diagnostics;   // present only when DIAGNOSTICS_ENABLED
}

interface Source {
  id: string;            // 'SOURCE_1'
  chunkId: string;
  transcriptId: string;
  moduleId: string;
  moduleName: string;
  classId: string;
  className: string;
  startTime: string;     // '12:31'
  endTime: string;       // '14:42'
  startMs: number;       // V2 playback seek
  endMs: number;
  excerpt: string;       // first ~240 chars, for the evidence card
}
```

`startMs`/`endMs` exist so V2's "Jump to recording" is a frontend-only change.
`excerpt` exists because evidence cards show a snippet. No other fields.

**Deliberately absent:** any numeric confidence. Retrieval scores exist in
`diagnostics` for debugging but are never presented as calibrated certainty.

```ts
interface Diagnostics {
  requestId: string;
  queries: { label: string; text: string }[];
  retrieval: { listId: string; count: number; latencyMs: number }[];
  fusedCount: number; contextChunkCount: number; contextTokens: number;
  judgeVerdict: string;
  latencyMs: { contextualize?: number; plan: number; retrieve: number;
               judge: number; generate: number; total: number };
  tokenUsage?: { plan: number; judge: number; generate: number };
}
```

### 16.2 Other endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/transcripts` | multipart upload → `202 { transcriptId, ingestionRunId, status }` |
| `GET` | `/api/transcripts/:id` | ingestion status and counts |
| `GET` | `/api/conversations/:id` | messages with their citations |
| `GET` | `/api/conversations` | list for `x-user-id` + `x-cohort-id` |
| `GET` | `/api/cohorts/:cohortId/catalog` | modules + classes for the UI (never given to the planner) |
| `GET` | `/health`, `/ready` | liveness; readiness checks database and extension |
| `ANY` | `/api/inngest` | Inngest serve handler |

### 16.3 Errors

```ts
{ error: { code: string; message: string; requestId: string; details?: unknown } }
```

Codes: `VALIDATION_ERROR` (400), `COHORT_NOT_FOUND` (404),
`CONVERSATION_NOT_FOUND` (404), `UNSUPPORTED_FILE_TYPE` (415),
`FILE_TOO_LARGE` (413), `RETRIEVAL_FAILED` (503), `LLM_FAILED` (503),
`UPSTREAM_TIMEOUT` (504), `INTERNAL_ERROR` (500).

Stack traces and provider error bodies are logged, never serialized to the
client. `details` carries Zod field errors only.

**Graceful degradation inside a chat request:** contextualizer failure → raw
question; planner failure → single-query plan; judge failure → `partial`;
one retriever failing → fuse the lists that succeeded; both retrievers failing
→ `RETRIEVAL_FAILED`; generation failure after one retry → `LLM_FAILED`.

---

## 17. Frontend Architecture

Vite + React + TypeScript + Tailwind. State is local to `useChat` — no global
store is warranted for a single chat view.

**Component responsibilities**

| Component | Responsibility |
|---|---|
| `ChatView` | Layout; owns conversation state via `useChat` |
| `MessageList` / `MessageBubble` | Turn rendering |
| `GroundingBadge` | The four statuses, each with distinct colour, icon, and label |
| `AnswerWithCitations` | Parses `[SOURCE_N]` in the answer text and renders each as a clickable pill that scrolls to and highlights its evidence card |
| `GeneralKnowledgeBlock` | Visually separated container for non-course content |
| `EvidenceCardList` / `EvidenceCard` | Module, class, timestamp range, excerpt |
| `PipelineProgress` | Staged progress while the request is in flight |
| `Composer` | Input, submit, disabled-while-pending |

**Grounding presentation**

| Status | Label | Treatment |
|---|---|---|
| `course_grounded` | "Course grounded" | Green badge; evidence cards below |
| `partially_grounded` | "Partly from the course" | Amber badge; general-knowledge portion in its own block |
| `general_knowledge` | "Not covered in the course" | Slate badge; explicit notice, then "General knowledge:", then "Closest course discussion:" |
| `conflicting` | "Sources disagree" | Purple badge; the cited conflicting sources emphasised |

The rule the UI enforces: a reader must never have to guess whether a sentence
came from the course or from the model.

**Evidence card (V1)**

```
┌──────────────────────────────────────────┐
│ SOURCE_1                                 │
│ Module 7 — Device Sensors                │
│ 2. Understanding the Gyroscope           │
│ 12:31 – 14:42                            │
│ "So this sensor measures how quickly…"   │
└──────────────────────────────────────────┘
```

V2 adds a "Jump to recording" button and a speaker line. Because `startMs`,
`endMs`, and the nullable `recording_url` already exist, that is a component
change only — no API, schema, or retrieval change.

---

## 18. Testing Strategy

`bun test`. Unit tests need no services; integration tests use the
docker-compose Postgres and are skipped when `TEST_DATABASE_URL` is unset.

### 18.1 Unit

| Area | Cases |
|---|---|
| SRT parsing | Well-formed; `HH:MM:SS,mmm`; blank-line handling; final cue without trailing newline |
| VTT parsing | `WEBVTT` header; `NOTE` blocks skipped; cue settings stripped; `<v Name>` → `speaker`; HTML entities decoded; `MM:SS.mmm` short form; empty cue ignored; `Speaker:` prefix extracted |
| Format detection | Extension/content mismatch → non-retriable error |
| Sentence segmentation | Abbreviations; decimals (`3.5`); `100%`; ellipses; lowercase continuation; no-punctuation ceiling; `x axis, y axis, z axis` stays one sentence |
| Reconstruction | **Sentence spanning multiple cues** takes first cue's start and last cue's end; sentence entirely inside one cue; cue containing two sentence ends |
| Chunking — size | Typical transcript lands in 350–650; target ≈ 500 |
| Chunking — sentences | No chunk boundary falls inside a sentence, ever |
| Chunking — R3 | **A sentence over 650 tokens** becomes its own intact chunk |
| Chunking — R4 | **A 2.5 s gap mid-paragraph** splits when past `minTokens`; the *same* gap early in a chunk does **not** split |
| Chunking — R5/R8 | Oversized-over-tiny preference; **class ending mid-topic** yields a short final chunk, unpadded |
| Chunking — R7 | Overlap is 10–15 %, whole sentences only, always makes forward progress |
| Chunking — edges | **Very short sentences**; **one long unpunctuated paragraph**; single-sentence transcript; empty transcript |
| Chunk identity | Same input → identical `chunk_key`s; changing `chunking_version` or `embedding_model` changes them; index zero-padded |
| Tokenizer | Deterministic; never estimated from character length |
| RRF | Known-input hand-computed score; `k` honoured from config; rank starts at 1; **the same chunk from multiple lists** sums correctly; empty lists tolerated; tie-break deterministic |
| Dedup | **Only** exact chunk IDs removed; **five adjacent chunks all ranked highly are all retained** |
| Context builder | Stops at budget; preserves RRF order; `SOURCE_N` assigned in rank order; budget smaller than one chunk yields exactly one |
| Planner schema | Valid plan; nulls and empty subqueries accepted; >3 subqueries truncated; duplicates dropped; garbage → fallback plan |
| Judge schema | All four verdicts; unknown source IDs dropped; malformed output → `partial` fallback |
| Citation validation | Valid markers map correctly; **fabricated `[SOURCE_9]` triggers regeneration**; still-invalid → stripped and status downgraded; `sufficient` with zero citations → downgraded |
| Grounding | Each verdict maps to the right status and prompt |
| History selection | Respects budget; keeps whole pairs; drops oldest first |
| Contextualization | Follow-up resolves the pronoun; first turn skips the LLM call entirely |

### 18.2 Integration (real Postgres)

- Migrations apply cleanly; `vector` extension present; HNSW and GIN indexes exist
- Vector retrieval returns nearest neighbours in the correct order
- Keyword retrieval ranks by `ts_rank_cd`; adversarial input (`"a & b | ("`) does not raise
- **Cohort isolation:** chunks seeded in cohort B are never returned for cohort A, by either retriever
- **Idempotent ingestion:** running the same transcript twice yields identical chunk counts and identical `chunk_key`s
- **Partial-ingestion recovery:** kill after `persist-chunks`, re-run, and only the missing embeddings are generated
- Composite FK rejects a chunk whose `cohort_id` disagrees with its class
- `transcripts_one_active_per_class` rejects a second active transcript

### 18.3 End-to-end

Full pipeline against a scripted mock `LLMProvider` and deterministic mock
`EmbeddingProvider`: planner → parallel retrieval → RRF → context → judge →
generation → citation validation → persisted message and citations. Asserts the
response matches the contract and that a fabricated citation is caught.

---

## 19. Evaluation Strategy

`apps/api/evals/`. A development-time script, not a platform.

### 19.1 Dataset

`dataset.yaml`, ~25 questions drawn from the real corpus, covering all seven
required categories:

```yaml
- id: gyro-001
  category: factual                 # factual | followup | multi_class |
                                    # cross_module | unanswerable |
                                    # ambiguous | conflicting
  question: "What does the gyroscope sensor measure?"
  priorTurns: []
  expectedClassSlugs: ["2-understanding-the-gyroscope"]
  expectedChunkKeys: []             # optional, for strict chunk-level scoring
  expectedGrounding: course_grounded
  notes: "Module 7, ~00:00:23"

- id: followup-002
  category: followup
  priorTurns:
    - role: user
      content: "What does the gyroscope sensor measure?"
    - role: assistant
      content: "It measures how quickly the device is rotating…"
  question: "Why does it matter for apps?"
  expectedClassSlugs: ["2-understanding-the-gyroscope"]
  expectedGrounding: course_grounded
```

Adding a question is appending one YAML object. The user reviews and corrects
the ground truth — that is the part only they can validate.

### 19.2 Metrics

**Retrieval**, scored against `expectedClassSlugs` (class-level) and, where
provided, `expectedChunkKeys` (chunk-level):

- `Recall@K` for K ∈ {5, 10, 20} over the post-RRF list
- `MRR` — reciprocal rank of the first relevant result
- `nDCG@10` — rewards putting relevant evidence near the top

**Answer quality:**

- **Citation correctness** — deterministic: every `[SOURCE_N]` resolves, and
  cited sources are a subset of the supplied evidence. Any failure is a bug,
  not a score.
- **Answerability detection** — predicted `groundingStatus` vs.
  `expectedGrounding`, reported as a confusion matrix. The `unanswerable`
  category is the important row: does the system admit it doesn't know?
- **Groundedness** — LLM-graded, claim-by-claim, against only the cited
  sources. Reported separately from deterministic metrics and never mixed into
  a single headline number.
- **Fallback behaviour** — for `unanswerable`, assert the answer explicitly
  says the transcripts do not cover it *and* that general knowledge is visibly
  separated.

Output: a console table plus `evals/results/<timestamp>.json` for diffing runs
after a change to chunking, prompts, or `k`.

---

## 20. Observability

Structured JSON logs via `pino`. `requestId` (per request) and
`conversationId` (per conversation) are attached through `AsyncLocalStorage`,
so every line in a request correlates without threading a logger argument.

**Chat spans:** `chat.request`, `chat.contextualize`, `chat.plan`,
`chat.retrieve.vector`, `chat.retrieve.keyword`, `chat.fuse`, `chat.context`,
`chat.judge`, `chat.generate`, `chat.validate_citations` — each with duration,
and with counts where meaningful (queries planned, results per list, fused
count, context chunks, context tokens, sources cited).

**Ingestion spans:** per Inngest step, plus cue/sentence/chunk/embedded counts
and every embedding failure with its batch index.

**Content policy:** questions and answers are **not** logged at `info`. Logged
instead are lengths, token counts, and identifiers. Full content is logged only
at `debug`, which is off outside development. Chunk text never appears in logs
— `chunk_key` identifies it unambiguously and is safe.

**Named anomaly events:** `citation.fabricated`, `planner.invalid_output`,
`judge.invalid_output`, `judge.unknown_source_ids`,
`grounding.downgraded_no_citations`, `embedding.batch_failed`,
`retrieval.partial_failure`. These are the events worth alerting on.

---

## 21. Security

- **Uploads:** multer in memory, 5 MB cap, extension allowlist (`.srt`,
  `.vtt`), MIME check, and content sniffing. Filenames are never used as paths.
- **SQL:** every query parameterized. No string interpolation of user input
  anywhere, including the tsquery, which goes through `websearch_to_tsquery`.
- **Request validation:** Zod on every body, param, query, and the identity
  headers. Unknown fields rejected.
- **LLM output is untrusted input:** parsed against a schema, then every
  identifier cross-checked against server-side data. This is the same posture
  as validating a request body.
- **Secrets:** `OPENAI_API_KEY` and `DATABASE_URL` live server-side only.
  `apps/web` receives nothing but `VITE_API_BASE_URL`. Config validation fails
  fast at boot if a required secret is absent.
- **Cohort scoping:** enforced in SQL and structurally reinforced by the
  composite foreign keys.
- **Known limitation, documented:** identity headers are unauthenticated in
  V1 and trivially spoofable. `requireCohortContext` is the single place where
  real authentication replaces them.

---

## 22. Configuration

`config/env.ts` validates all of this with Zod at boot and exits on failure.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | |
| `PORT` | `3000` | API port |
| `DATABASE_URL` | — | Postgres connection (required) |
| `TEST_DATABASE_URL` | — | Integration tests; unset skips them |
| `OPENAI_API_KEY` | — | Required |
| `LLM_MODEL` | `gpt-5.6-luna` | Chat/planner/judge model |
| `LLM_REASONING_EFFORT_PLANNER` | `low` | |
| `LLM_REASONING_EFFORT_CONTEXTUALIZER` | `low` | |
| `LLM_REASONING_EFFORT_JUDGE` | `medium` | |
| `LLM_REASONING_EFFORT_ANSWER` | `medium` | |
| `LLM_TIMEOUT_MS` | `60000` | Per call |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Also stored per chunk |
| `EMBEDDING_DIMENSIONS` | `1536` | Must match the `vector(n)` column |
| `EMBEDDING_BATCH_SIZE` | `96` | Inputs per embeddings call |
| `CHUNKING_VERSION` | `v1` | Active version for read and write |
| `CHUNK_TARGET_TOKENS` | `500` | |
| `CHUNK_MIN_TOKENS` | `350` | |
| `CHUNK_MAX_TOKENS` | `650` | |
| `CHUNK_OVERLAP_RATIO` | `0.125` | 12.5 %, midpoint of 10–15 % |
| `CHUNK_GAP_PREFERRED_MS` | `2000` | Soft boundary preference |
| `TOKENIZER_ENCODING` | `o200k_base` | |
| `RETRIEVAL_TOP_K_VECTOR` | `10` | Per query |
| `RETRIEVAL_TOP_K_KEYWORD` | `10` | Per query |
| `RRF_K` | `60` | Read in one place only |
| `MAX_QUERIES` | `6` | Contextualized + rewrite + step-back + ≤3 subqueries |
| `MAX_SUBQUERIES` | `3` | |
| `CONTEXT_TOKEN_BUDGET` | `8000` | Evidence sent to the answer model |
| `CONVERSATION_HISTORY_TOKEN_BUDGET` | `1500` | |
| `ALLOW_GENERAL_KNOWLEDGE_FALLBACK` | `true` | |
| `HNSW_M` | `16` | Build-time |
| `HNSW_EF_CONSTRUCTION` | `64` | Build-time |
| `HNSW_EF_SEARCH` | `64` | Query-time |
| `FTS_LANGUAGE` | `english` | tsvector configuration |
| `INGEST_CONCURRENCY` | `4` | Inngest concurrent runs |
| `MAX_UPLOAD_BYTES` | `5242880` | 5 MB |
| `DIAGNOSTICS_ENABLED` | `false` | Include `diagnostics` in responses |
| `LOG_LEVEL` | `info` | |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | — | Unused with the dev server |
| `VITE_API_BASE_URL` | `http://localhost:3000` | Frontend only |

---

## 23. Setup and Run

```bash
# 1. dependencies
bun install

# 2. database
docker compose up -d                     # pgvector/pgvector:pg17 on 5432
cp .env.example .env                     # then set OPENAI_API_KEY
bun run migrate

# 3. build the seed manifest, then EDIT IT
bun run build-manifest                   # recordings/ → seed.manifest.json
#   → fix module 17's class titles, confirm "Bonus Content" (module 18),
#     check ordering, then save

# 4. run the services (three terminals)
bun run dev:api                          # Express + /api/inngest
bunx inngest-cli@latest dev -u http://localhost:3000/api/inngest
bun run dev:web                          # Vite

# 5. ingest the corpus
bun run seed:transcripts                 # emits 87 ingest events
#   watch progress at http://localhost:8288 (Inngest dev UI)

# 6. verify
bun test                                 # unit
TEST_DATABASE_URL=... bun test           # unit + integration
bun run eval                             # retrieval + answer metrics
```

---

## 24. Delivery Phases

| Phase | Contents | Done when |
|---|---|---|
| **1. Foundation** | Workspaces, docker-compose, migrations + runner, Drizzle schema, config validation, logger, error handling, Express skeleton, health checks | `bun run migrate` succeeds; `/health` and `/ready` pass; config fails fast on a missing secret |
| **2. Deterministic core** | SRT/VTT parsers, segmenter, reconstruction, tokenizer, chunker, chunk keys — with the full unit suite | Every §18.1 unit test passes; chunker output on a real class inspected by hand |
| **3. Ingestion** | Embedding provider, Inngest workflow, upload endpoint, manifest builder, seeder, ingestion_runs | All 87 classes indexed; re-running the seeder adds zero rows |
| **4. Retrieval and chat** | Both retrievers, RRF, dedup, context builder, contextualizer, planner, judge, generation, citation validation, `POST /api/chat`, conversation persistence | Integration + e2e pass; cohort isolation proven; a fabricated citation is caught |
| **5. Frontend and evaluation** | React chat UI with grounding badges and evidence cards; eval dataset, harness, and metrics | UI shows all four grounding states correctly; `bun run eval` reports Recall@K, MRR, nDCG, and the answerability confusion matrix |

Each phase is reviewable on its own and leaves the repository in a working
state.

---

## 25. Traceability

Every numbered requirement in the brief maps to a section here: architecture
§1; unspecified decisions §2; schema §3; structure §4; ingestion §5, §7;
chunking §6; retrieval §10; RRF §11; post-RRF and context §12; evidence
assessment §13; grounding and generation §14; conversation memory §15; API §16;
frontend §17; tests §18; evaluation §19; observability §20; security §21;
configuration §22; setup §23.

The non-requirements are honoured by omission: there is no video processing, no
speaker retrieval, no external vector store, no neural reranker, no semantic
deduplication, no post-RRF diversity filtering, no LLM-driven chunking, and no
numeric confidence score anywhere in the response contract.
