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
