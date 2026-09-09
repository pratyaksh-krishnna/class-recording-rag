import type { ApiErrorCode } from '@rag/shared';

/** Typed HTTP failure from the API (spec §16.3). */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly requestId: string | null;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string, status: number, requestId: string | null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

/**
 * User-facing copy names the fix, not just the problem (plan §A.9).
 * Components render `message`; `retry` is the action label for recoverable errors.
 */
export function userFacingError(code: ApiErrorCode): { message: string; retry: string | null } {
  switch (code) {
    case 'VALIDATION_ERROR':
      return {
        message: 'That question could not be sent. Shorten it and try again.',
        retry: null,
      };
    case 'NOT_FOUND':
      return {
        message: 'That resource was not found. Refresh the page and try again.',
        retry: null,
      };
    case 'COHORT_NOT_FOUND':
      return {
        message:
          'This cohort is not configured. Check PUBLIC_COHORT_ID in .env matches a seeded cohort.',
        retry: null,
      };
    case 'CONVERSATION_NOT_FOUND':
      return {
        message: 'That conversation no longer exists. Start a new thread.',
        retry: null,
      };
    case 'TRANSCRIPT_NOT_FOUND':
      return {
        message: 'That transcript was not found. Refresh and try again.',
        retry: null,
      };
    case 'UNSUPPORTED_FILE_TYPE':
      return {
        message: 'Only .srt and .vtt transcript files are supported.',
        retry: null,
      };
    case 'FILE_TOO_LARGE':
      return {
        message: 'The file is too large. Upload a transcript under 5\u00a0MB.',
        retry: null,
      };
    case 'RETRIEVAL_FAILED':
      return {
        message:
          'Searching the transcripts failed. Try again in a moment, or rephrase the question.',
        retry: 'Try Again',
      };
    case 'LLM_FAILED':
      return {
        message:
          'The answer service did not respond. Try again, or rephrase the question.',
        retry: 'Try Again',
      };
    case 'UPSTREAM_TIMEOUT':
      return {
        message:
          'The answer service timed out. Try again, or ask a shorter question.',
        retry: 'Try Again',
      };
    case 'INTERNAL_ERROR':
      return {
        message:
          'Something went wrong on the server. Try again, or rephrase the question.',
        retry: 'Try Again',
      };
    default: {
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}
