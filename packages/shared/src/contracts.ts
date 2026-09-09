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
  /**
   * Chunk ids after RRF and exact-id dedup, in fused rank order — the list spec
   * §19.2 scores retrieval against. Diagnostics-only: it is never shown to a
   * user and is absent unless DIAGNOSTICS_ENABLED.
   */
  fusedChunkIds: string[];
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

/** One row in the conversation sidebar / history list (spec §16.2). */
export interface ConversationSummary {
  id: string;
  cohortId: string;
  userId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Response body for `GET /api/conversations` (spec §16.2). */
export interface ConversationListResponse {
  conversations: ConversationSummary[];
}

/** A single persisted turn when reloading a conversation (spec §16.2). */
export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  groundingStatus: GroundingStatus | null;
  createdAt: string;
  /** Hydrated evidence entries for assistant turns; always `[]` for user turns. */
  sources: Source[];
}

/** Response body for `GET /api/conversations/:id` (spec §16.2). */
export interface ConversationDetailResponse {
  conversationId: string;
  messages: ConversationMessage[];
}

export interface CatalogClass {
  id: string;
  slug: string;
  name: string;
  position: number;
}

export interface CatalogModule {
  id: string;
  slug: string;
  name: string;
  position: number;
  classes: CatalogClass[];
}

/**
 * Response body for `GET /api/cohorts/:cohortId/catalog` (spec §16.2) — the
 * modules and classes the UI browses. Never handed to the query planner:
 * spec §9 keeps the 87 class titles away from query formulation so the planner
 * cannot bias toward titles that happen to match the question's wording.
 */
export interface CatalogResponse {
  cohortId: string;
  cohortSlug: string;
  cohortName: string;
  modules: CatalogModule[];
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
