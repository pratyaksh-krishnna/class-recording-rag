import type { GroundingStatus, Source } from '@rag/shared';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { buildSource } from '../../rag/context/sources';
import type { Database } from '../client';
import { conversations, messageCitations, messages } from '../schema';
import { hydrateChunksByIds } from './chunks.repo';


export interface ConversationRow {
  id: string;
  cohortId: string;
  userId: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  groundingStatus: GroundingStatus | null;
  tokenCount: number | null;
  createdAt: Date;
}

export interface CitationInput {
  chunkId: string;
  sourceId: string;
}

const CONVERSATION_COLUMNS = {
  id: conversations.id,
  cohortId: conversations.cohortId,
  userId: conversations.userId,
  title: conversations.title,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
};

const MESSAGE_COLUMNS = {
  id: messages.id,
  conversationId: messages.conversationId,
  role: messages.role,
  content: messages.content,
  groundingStatus: messages.groundingStatus,
  tokenCount: messages.tokenCount,
  createdAt: messages.createdAt,
};

export async function createConversation(
  db: Database,
  input: { cohortId: string; userId: string; title?: string | null },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(conversations)
    .values({ cohortId: input.cohortId, userId: input.userId, title: input.title ?? null })
    .returning({ id: conversations.id });

  if (!row) throw new Error('createConversation: insert returned no row');
  return row;
}

/**
 * A conversation belongs to one user AND one cohort (spec §21/§16.1) — the
 * WHERE clause filters on BOTH `user_id` and `cohort_id`, never on `id`
 * alone, so a guessed or shared conversation id can never be read across a
 * user or cohort boundary. `scope` is required (not optional) so this check
 * cannot be forgotten by a caller.
 */
export async function findConversation(
  db: Database,
  id: string,
  scope: { userId: string; cohortId: string },
): Promise<ConversationRow | null> {
  const [row] = await db
    .select(CONVERSATION_COLUMNS)
    .from(conversations)
    .where(
      and(
        eq(conversations.id, id),
        eq(conversations.userId, scope.userId),
        eq(conversations.cohortId, scope.cohortId),
      ),
    );
  return row ?? null;
}

/**
 * Same cross-user/cross-cohort guard as findConversation — see comment
 * there. Ordered by `updated_at DESC` to match `conversations_user_idx`
 * (user_id, cohort_id, updated_at DESC), so a listing is an index scan.
 */
export async function listConversations(
  db: Database,
  scope: { userId: string; cohortId: string },
  limit = 50,
): Promise<ConversationRow[]> {
  return db
    .select(CONVERSATION_COLUMNS)
    .from(conversations)
    .where(and(eq(conversations.userId, scope.userId), eq(conversations.cohortId, scope.cohortId)))
    .orderBy(desc(conversations.updatedAt))
    .limit(limit);
}

/**
 * `citations` is optional and, when non-empty, the message insert and the
 * citation inserts commit in ONE transaction: a message whose citations
 * failed to write would render as an uncited answer, which the API contract
 * (spec §16.1) treats as a different grounding state than what was actually
 * generated. `saveCitations` below remains a standalone export for callers
 * that attach citations to an already-written message.
 */
export async function appendMessage(
  db: Database,
  input: {
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
    groundingStatus?: GroundingStatus | null;
    citations?: CitationInput[];
  },
): Promise<{ id: string }> {
  const values = {
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    groundingStatus: input.groundingStatus ?? null,
  };

  if (!input.citations || input.citations.length === 0) {
    const [row] = await db.insert(messages).values(values).returning({ id: messages.id });
    if (!row) throw new Error('appendMessage: insert returned no row');
    return row;
  }

  const citations = input.citations;
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(messages).values(values).returning({ id: messages.id });
    if (!row) throw new Error('appendMessage: insert returned no row');

    await tx.insert(messageCitations).values(
      citations.map((c, i) => ({
        messageId: row.id,
        chunkId: c.chunkId,
        sourceId: c.sourceId,
        rank: i + 1,
      })),
    );

    return row;
  });
}

/**
 * Ordered by (created_at, id) to match `messages_conversation_idx` — the id
 * tie-break keeps ordering deterministic for messages inserted in the same
 * millisecond.
 */
export async function listMessages(db: Database, conversationId: string): Promise<MessageRow[]> {
  return db
    .select(MESSAGE_COLUMNS)
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(messages.id));
}

/**
 * `rank` is derived from array order (1-based) rather than accepted as
 * input — the caller supplies citations already in display order, so there
 * is nothing else `rank` could mean.
 */
export async function saveCitations(
  db: Database,
  input: { messageId: string; citations: CitationInput[] },
): Promise<void> {
  if (input.citations.length === 0) return;

  await db.insert(messageCitations).values(
    input.citations.map((c, i) => ({
      messageId: input.messageId,
      chunkId: c.chunkId,
      sourceId: c.sourceId,
      rank: i + 1,
    })),
  );
}

/**
 * Two queries rather than a join, mirroring listModulesWithClasses: a
 * message with zero citations must still appear, with `citations: []`
 * rather than being dropped or coming back null.
 */
export async function listMessagesWithCitations(
  db: Database,
  conversationId: string,
): Promise<Array<MessageRow & { citations: CitationInput[] }>> {
  const msgs = await listMessages(db, conversationId);
  if (msgs.length === 0) return [];

  const citationRows = await db
    .select({
      messageId: messageCitations.messageId,
      chunkId: messageCitations.chunkId,
      sourceId: messageCitations.sourceId,
    })
    .from(messageCitations)
    .where(inArray(messageCitations.messageId, msgs.map((m) => m.id)))
    .orderBy(asc(messageCitations.rank));

  const citationsByMessageId = new Map<string, CitationInput[]>();
  for (const row of citationRows) {
    const bucket = citationsByMessageId.get(row.messageId);
    const entry = { chunkId: row.chunkId, sourceId: row.sourceId };
    if (bucket) {
      bucket.push(entry);
    } else {
      citationsByMessageId.set(row.messageId, [entry]);
    }
  }

  return msgs.map((m) => ({ ...m, citations: citationsByMessageId.get(m.id) ?? [] }));
}

export interface MessageWithSources {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  groundingStatus: GroundingStatus | null;
  createdAt: Date;
  sources: Source[];
}

/**
 * Reloads a conversation with fully hydrated evidence entries (spec §12.3):
 * citation rows supply only `(chunkId, sourceId)`; every display field comes
 * from `hydrateChunksByIds`, the same path the orchestrator uses. One batched
 * hydration for the whole conversation — not one query per message — keeps
 * reload latency bounded and guarantees formatting stays in one code path.
 * Chunks that no longer resolve inside `cohortId` are dropped, not rendered
 * as holes; citation `rank` ordering is preserved per message.
 */
export async function listMessagesWithHydratedSources(
  db: Database,
  conversationId: string,
  cohortId: string,
): Promise<MessageWithSources[]> {
  const msgs = await listMessages(db, conversationId);
  if (msgs.length === 0) return [];

  const citationRows = await db
    .select({
      messageId: messageCitations.messageId,
      chunkId: messageCitations.chunkId,
      sourceId: messageCitations.sourceId,
    })
    .from(messageCitations)
    .where(inArray(messageCitations.messageId, msgs.map((m) => m.id)))
    .orderBy(asc(messageCitations.rank));

  const citationsByMessageId = new Map<string, CitationInput[]>();
  for (const row of citationRows) {
    const bucket = citationsByMessageId.get(row.messageId);
    const entry = { chunkId: row.chunkId, sourceId: row.sourceId };
    if (bucket) {
      bucket.push(entry);
    } else {
      citationsByMessageId.set(row.messageId, [entry]);
    }
  }

  const uniqueChunkIds = [...new Set(citationRows.map((r) => r.chunkId))];
  const hydrated = await hydrateChunksByIds(db, uniqueChunkIds, cohortId);
  const chunkById = new Map(hydrated.map((c) => [c.id, c]));

  return msgs.map((m) => {
    if (m.role === 'user') {
      return {
        id: m.id,
        conversationId: m.conversationId,
        role: m.role,
        content: m.content,
        groundingStatus: m.groundingStatus,
        createdAt: m.createdAt,
        sources: [],
      };
    }

    const citations = citationsByMessageId.get(m.id) ?? [];
    const sources: Source[] = [];
    for (const citation of citations) {
      const chunk = chunkById.get(citation.chunkId);
      if (chunk === undefined) continue;
      sources.push(buildSource(citation.sourceId, chunk));
    }

    return {
      id: m.id,
      conversationId: m.conversationId,
      role: m.role,
      content: m.content,
      groundingStatus: m.groundingStatus,
      createdAt: m.createdAt,
      sources,
    };
  });
}

/** Bumps updated_at so listConversations sorts this conversation first. */
export async function touchConversation(db: Database, id: string): Promise<void> {
  await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, id));
}
