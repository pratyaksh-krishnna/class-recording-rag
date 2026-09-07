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
