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
 * express.json() rejects malformed and oversized bodies by throwing an
 * untyped `http-errors` instance tagged with a `type` string. Those are
 * routine client mistakes, not server faults, so the boundary recognizes them
 * rather than reporting a 500. The original message never crosses the
 * boundary — only these fixed strings do.
 */
const BODY_PARSER_ERRORS: Record<string, { code: ApiErrorCode; message: string }> = {
  'entity.parse.failed': { code: 'VALIDATION_ERROR', message: 'Malformed JSON body.' },
  'entity.too.large': { code: 'FILE_TOO_LARGE', message: 'Request body too large.' },
};

/** Shape check, not a cast: these errors come from a third party and are untyped. */
function bodyParserErrorType(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { type } = error as { type?: unknown };
  return typeof type === 'string' ? type : undefined;
}

export interface ErrorBoundaryResult {
  status: number;
  body: ApiErrorBody;
  /**
   * True when the boundary recognized the error and chose its status and
   * message deliberately. False means genuine surprise — the caller logs a
   * stack for those and only those.
   */
  expected: boolean;
}

/**
 * Converts anything thrown into an HTTP status and a client-safe body.
 * Only AppError messages and the fixed body-parser messages cross the
 * boundary; everything else becomes a generic 500 whose real detail is
 * logged, not returned.
 */
export function toErrorBody(error: unknown, requestId: string): ErrorBoundaryResult {
  if (isAppError(error)) {
    return {
      status: error.statusCode,
      expected: true,
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

  const bodyParser = BODY_PARSER_ERRORS[bodyParserErrorType(error) ?? ''];
  if (bodyParser) {
    return {
      status: STATUS_BY_CODE[bodyParser.code],
      expected: true,
      body: {
        error: { code: bodyParser.code, message: bodyParser.message, requestId },
      },
    };
  }

  return {
    status: 500,
    expected: false,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        requestId,
      },
    },
  };
}
