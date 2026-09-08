import { AppError } from '../../errors/AppError';

/**
 * A malformed transcript is permanently malformed — the same bytes will fail
 * the same way forever. Inngest reads `retriable` to fail the step outright
 * instead of burning its retry budget (spec §5.1).
 */
export class TranscriptParseError extends AppError {
  readonly retriable = false;

  constructor(message: string, details?: unknown) {
    super('VALIDATION_ERROR', message, details !== undefined ? { details } : {});
  }
}
