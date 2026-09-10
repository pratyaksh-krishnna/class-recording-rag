import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { runMigrations } from '../../../apps/api/migrations/run';
import { createPool, createDb, closePool, type Database } from '../../../apps/api/src/db/client';
import { assertTestDatabase } from '../../helpers/assertTestDatabase';
import { upsertCohort } from '../../../apps/api/src/db/repositories/cohorts.repo';
import { upsertModule } from '../../../apps/api/src/db/repositories/modules.repo';
import { upsertClass } from '../../../apps/api/src/db/repositories/classes.repo';
import { upsertTranscript } from '../../../apps/api/src/db/repositories/transcripts.repo';
import { bulkInsertChunks, type ChunkInsert } from '../../../apps/api/src/db/repositories/chunks.repo';
import {
  createConversation,
  findConversation,
  listConversations,
  appendMessage,
  listMessages,
  saveCitations,
  listMessagesWithCitations,
  listMessagesWithHydratedSources,
  touchConversation,
} from '../../../apps/api/src/db/repositories/conversations.repo';
import type { Pool } from 'pg';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

function chunkFixture(overrides: Partial<ChunkInsert> & Pick<ChunkInsert, 'transcriptId' | 'cohortId' | 'moduleId' | 'classId' | 'chunkKey' | 'chunkIndex'>): ChunkInsert {
  return {
    text: `chunk text ${overrides.chunkIndex}`,
    startMs: overrides.chunkIndex * 1000,
    endMs: overrides.chunkIndex * 1000 + 500,
    tokenCount: 10,
    sentenceCount: 1,
    overlapSentenceCount: 0,
    chunkingVersion: 'v1',
    tokenizer: 'o200k_base',
    embeddingModel: 'text-embedding-3-small',
    embeddingDimensions: 1536,
    ...overrides,
  };
}

describeDb('conversations repository', () => {
  const url = TEST_DATABASE_URL as string;
  let pool: Pool;
  let db: Database;

  let cohortId: string;
  let moduleId: string;
  let classId: string;
  let transcriptId: string;
  let chunkIdA: string;
  let chunkIdB: string;

  beforeAll(async () => {
    assertTestDatabase(url);
    await runMigrations(url);
    pool = createPool(url);
    db = createDb(pool);
    await pool.query('TRUNCATE cohorts CASCADE');

    const cohort = await upsertCohort(db, { slug: 'conv-test-cohort', name: 'Conv Test Cohort' });
    cohortId = cohort.id;
    const mod = await upsertModule(db, { cohortId, slug: 'conv-module', name: 'Conv Module', position: 1 });
    moduleId = mod.id;
    const klass = await upsertClass(db, { cohortId, moduleId, slug: 'conv-class', name: 'Conv Class', position: 1 });
    classId = klass.id;
    const transcript = await upsertTranscript(db, {
      cohortId, moduleId, classId,
      format: 'vtt', sourceUri: 'recordings/conv.vtt', contentHash: 'conv-hash-1', byteSize: 10,
    });
    transcriptId = transcript.id;

    const rows: ChunkInsert[] = [0, 1].map((i) =>
      chunkFixture({
        transcriptId, cohortId, moduleId, classId,
        chunkKey: `conv-test:${transcriptId}:${i}`,
        chunkIndex: i,
      }),
    );
    await bulkInsertChunks(db, rows);
    const chunkRows = await pool.query<{ id: string }>(
      'SELECT id FROM chunks WHERE transcript_id = $1 ORDER BY chunk_index', [transcriptId],
    );
    const [a, b] = chunkRows.rows.map((r) => r.id);
    if (!a || !b) throw new Error('expected two fixture chunks');
    chunkIdA = a;
    chunkIdB = b;
  });

  afterAll(async () => {
    await pool.query('TRUNCATE cohorts CASCADE');
    await closePool(pool);
  });

  describe('createConversation / findConversation', () => {
    test('round-trips a created conversation by id within its own scope', async () => {
      const created = await createConversation(db, { cohortId, userId: 'user-1', title: 'Hello' });
      const found = await findConversation(db, created.id, { userId: 'user-1', cohortId });
      expect(found?.id).toBe(created.id);
      expect(found?.title).toBe('Hello');
      expect(found?.cohortId).toBe(cohortId);
      expect(found?.userId).toBe('user-1');
    });

    test('returns null for the right id with the WRONG userId', async () => {
      const created = await createConversation(db, { cohortId, userId: 'user-2', title: null });
      const found = await findConversation(db, created.id, { userId: 'someone-else', cohortId });
      expect(found).toBeNull();
    });

    test('returns null for the right id with the WRONG cohortId', async () => {
      const otherCohort = await upsertCohort(db, { slug: 'conv-test-other-cohort', name: 'Other Cohort' });
      const created = await createConversation(db, { cohortId, userId: 'user-3', title: null });
      const found = await findConversation(db, created.id, { userId: 'user-3', cohortId: otherCohort.id });
      expect(found).toBeNull();
    });

    test('returns null for an unknown id', async () => {
      const found = await findConversation(db, '00000000-0000-0000-0000-000000000000', {
        userId: 'nobody', cohortId,
      });
      expect(found).toBeNull();
    });
  });

  describe('listConversations', () => {
    test("returns only the caller's own conversations, ordered by recency", async () => {
      const userId = 'list-user';
      const otherUserId = 'other-list-user';

      const first = await createConversation(db, { cohortId, userId, title: 'First' });
      const second = await createConversation(db, { cohortId, userId, title: 'Second' });
      await createConversation(db, { cohortId, userId: otherUserId, title: 'Not mine' });

      // Freshly created, `second` should already outrank `first` by recency.
      const initial = await listConversations(db, { userId, cohortId });
      expect(initial.map((c) => c.id)).toEqual([second.id, first.id]);

      // touchConversation bumps updated_at, so `first` should now sort ahead.
      await touchConversation(db, first.id);
      const afterTouch = await listConversations(db, { userId, cohortId });
      expect(afterTouch.map((c) => c.id)).toEqual([first.id, second.id]);
      expect(afterTouch.every((c) => c.userId === userId)).toBe(true);
    });

    test('includes the first user question for legacy null-title fallback', async () => {
      const userId = 'legacy-title-list-user';
      const conversation = await createConversation(db, { cohortId, userId, title: null });
      await appendMessage(db, { conversationId: conversation.id, role: 'assistant', content: 'Assistant preface' });
      await appendMessage(db, {
        conversationId: conversation.id,
        role: 'user',
        content: '  How   does\nnormalization work?  ',
      });
      await appendMessage(db, { conversationId: conversation.id, role: 'user', content: 'Second question' });

      const listed = await listConversations(db, { userId, cohortId });

      expect(listed).toHaveLength(1);
      expect(listed[0]?.title).toBeNull();
      expect(listed[0]?.firstUserQuestion).toBe('  How   does\nnormalization work?  ');
    });
  });

  describe('appendMessage / listMessages', () => {
    test('preserves chronological order', async () => {
      const conv = await createConversation(db, { cohortId, userId: 'msg-user', title: null });
      const m1 = await appendMessage(db, { conversationId: conv.id, role: 'user', content: 'Q1' });
      const m2 = await appendMessage(db, {
        conversationId: conv.id, role: 'assistant', content: 'A1', groundingStatus: 'course_grounded',
      });
      const m3 = await appendMessage(db, { conversationId: conv.id, role: 'user', content: 'Q2' });

      const msgs = await listMessages(db, conv.id);
      expect(msgs.map((m) => m.id)).toEqual([m1.id, m2.id, m3.id]);
      expect(msgs.map((m) => m.content)).toEqual(['Q1', 'A1', 'Q2']);
      expect(msgs[1]?.groundingStatus).toBe('course_grounded');
      expect(msgs[0]?.groundingStatus).toBeNull();
    });
  });

  describe('saveCitations / listMessagesWithCitations', () => {
    test('round-trips citations with the right sourceId to chunkId mapping', async () => {
      const conv = await createConversation(db, { cohortId, userId: 'cite-user', title: null });
      const assistantMsg = await appendMessage(db, {
        conversationId: conv.id, role: 'assistant', content: 'Answer', groundingStatus: 'course_grounded',
      });

      await saveCitations(db, {
        messageId: assistantMsg.id,
        citations: [
          { sourceId: 'SOURCE_1', chunkId: chunkIdA },
          { sourceId: 'SOURCE_2', chunkId: chunkIdB },
        ],
      });

      const withCitations = await listMessagesWithCitations(db, conv.id);
      expect(withCitations).toHaveLength(1);
      expect(withCitations[0]?.citations).toEqual([
        { sourceId: 'SOURCE_1', chunkId: chunkIdA },
        { sourceId: 'SOURCE_2', chunkId: chunkIdB },
      ]);
    });

    test('a message with no citations comes back with an empty array, not null', async () => {
      const conv = await createConversation(db, { cohortId, userId: 'no-cite-user', title: null });
      await appendMessage(db, { conversationId: conv.id, role: 'user', content: 'Hi' });

      const withCitations = await listMessagesWithCitations(db, conv.id);
      expect(withCitations).toHaveLength(1);
      expect(withCitations[0]?.citations).toEqual([]);
    });

    test('citations are deleted with their message (ON DELETE CASCADE)', async () => {
      const conv = await createConversation(db, { cohortId, userId: 'cascade-user', title: null });
      const assistantMsg = await appendMessage(db, {
        conversationId: conv.id, role: 'assistant', content: 'Answer', groundingStatus: 'course_grounded',
      });
      await saveCitations(db, {
        messageId: assistantMsg.id,
        citations: [{ sourceId: 'SOURCE_1', chunkId: chunkIdA }],
      });

      const before = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM message_citations WHERE message_id = $1', [assistantMsg.id],
      );
      expect(before.rows[0]?.count).toBe(1);

      await pool.query('DELETE FROM messages WHERE id = $1', [assistantMsg.id]);

      const after = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM message_citations WHERE message_id = $1', [assistantMsg.id],
      );
      expect(after.rows[0]?.count).toBe(0);
    });
  });

  describe('listMessagesWithHydratedSources', () => {
    test('hydrates citations into full Source objects in rank order', async () => {
      const conv = await createConversation(db, { cohortId, userId: 'hydrate-user', title: null });
      await appendMessage(db, { conversationId: conv.id, role: 'user', content: 'Question' });
      const assistantMsg = await appendMessage(db, {
        conversationId: conv.id,
        role: 'assistant',
        content: 'Answer with two sources',
        groundingStatus: 'course_grounded',
        citations: [
          { sourceId: 'SOURCE_1', chunkId: chunkIdA },
          { sourceId: 'SOURCE_2', chunkId: chunkIdB },
        ],
      });

      const messages = await listMessagesWithHydratedSources(db, conv.id, cohortId);
      expect(messages).toHaveLength(2);
      expect(messages[0]?.sources).toEqual([]);
      expect(messages[1]?.id).toBe(assistantMsg.id);
      expect(messages[1]?.sources.map((s) => s.id)).toEqual(['SOURCE_1', 'SOURCE_2']);
      expect(messages[1]?.sources[0]?.moduleName).toBe('Conv Module');
      expect(messages[1]?.sources[0]?.className).toBe('Conv Class');
      expect(messages[1]?.sources[0]?.excerpt.length).toBeGreaterThan(0);
      expect(messages[1]?.sources[0]?.startMs).toBe(0);
      expect(messages[1]?.sources[1]?.startMs).toBe(1000);
    });

    test('drops chunks that no longer resolve inside the cohort', async () => {
      const otherCohort = await upsertCohort(db, { slug: 'conv-hydrate-other', name: 'Other' });
      const conv = await createConversation(db, { cohortId, userId: 'drop-user', title: null });
      await appendMessage(db, {
        conversationId: conv.id,
        role: 'assistant',
        content: 'Answer',
        groundingStatus: 'course_grounded',
        citations: [{ sourceId: 'SOURCE_1', chunkId: chunkIdA }],
      });

      const inCohort = await listMessagesWithHydratedSources(db, conv.id, cohortId);
      expect(inCohort[0]?.sources).toHaveLength(1);

      const wrongCohort = await listMessagesWithHydratedSources(db, conv.id, otherCohort.id);
      expect(wrongCohort[0]?.sources).toEqual([]);
    });
  });

  describe('appendMessage with inline citations (atomic save)', () => {
    test('commits the assistant message and its citations together', async () => {
      const conv = await createConversation(db, { cohortId, userId: 'atomic-user', title: null });
      const msg = await appendMessage(db, {
        conversationId: conv.id,
        role: 'assistant',
        content: 'Grounded answer',
        groundingStatus: 'course_grounded',
        citations: [{ sourceId: 'SOURCE_1', chunkId: chunkIdA }],
      });

      const withCitations = await listMessagesWithCitations(db, conv.id);
      expect(withCitations).toHaveLength(1);
      expect(withCitations[0]?.id).toBe(msg.id);
      expect(withCitations[0]?.citations).toEqual([{ sourceId: 'SOURCE_1', chunkId: chunkIdA }]);
    });
  });
});
