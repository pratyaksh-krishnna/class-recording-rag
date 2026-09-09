import { NonRetriableError } from 'inngest';
import { isAppError } from '../errors/AppError';
import { PermanentIngestError } from '../ingestion/pipeline';

/**
 * A permanent failure cannot succeed on retry, so it is converted rather than
 * left to consume Inngest's retry budget. Everything else propagates unchanged
 * and stays retryable.
 */
export function toInngestError(error: unknown): Error {
  if (error instanceof PermanentIngestError) return new NonRetriableError(error.message);
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Only our own error types have messages that are safe to persist on the run
 * row. Anything else — a driver error carrying SQL and parameters, a provider
 * error carrying a response body — is reduced to a fixed string, because that
 * message is later shown to a user (spec §16.3, §21).
 */
export function safeErrorMessage(
  error: unknown,
  activity: string,
): { code: string; message: string } {
  if (error instanceof PermanentIngestError) return { code: error.code, message: error.message };
  if (isAppError(error)) return { code: error.code, message: error.message };

  return {
    code: 'UNKNOWN_ERROR',
    message: `An error occurred during ${activity}; see logs for details.`,
  };
}
