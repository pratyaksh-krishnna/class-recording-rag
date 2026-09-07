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
