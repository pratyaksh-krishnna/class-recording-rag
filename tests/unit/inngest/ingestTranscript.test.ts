import { safeErrorMessage, toInngestError } from '../../../apps/api/src/inngest/errors';
import { test, expect, describe } from 'bun:test';
import { NonRetriableError } from 'inngest';
import { AppError } from '../../../apps/api/src/errors/AppError';
import { PermanentIngestError } from '../../../apps/api/src/ingestion/pipeline';


describe('ingestTranscript error mapping', () => {
  describe('toInngestError', () => {
    test('PermanentIngestError maps to NonRetriableError', () => {
      const permanentError = new PermanentIngestError('HASH_MISMATCH', 'File hash changed');
      const result = toInngestError(permanentError);

      expect(result).toBeInstanceOf(NonRetriableError);
      expect(result.message).toBe('File hash changed');
    });

    test('ordinary Error stays retryable', () => {
      const ordinaryError = new Error('Network timeout');
      const result = toInngestError(ordinaryError);

      expect(result).toBeInstanceOf(Error);
      expect(result).not.toBeInstanceOf(NonRetriableError);
      expect(result.message).toBe('Network timeout');
    });

    test('non-Error value becomes an Error', () => {
      const result = toInngestError('some string');

      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('some string');
    });
  });

  describe('safeErrorMessage', () => {
    test('PermanentIngestError returns code and message intact', () => {
      const error = new PermanentIngestError('PARSE_ERROR', 'Failed to parse SRT');
      const result = safeErrorMessage(error, 'ingestion');

      expect(result.code).toBe('PARSE_ERROR');
      expect(result.message).toBe('Failed to parse SRT');
    });

    test('a driver error carrying a code does not leak its message', () => {
      // A pg error's message can quote the failing SQL and its parameters, and
      // this message is persisted on the run row and shown to a user.
      const error = Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      });
      const result = safeErrorMessage(error, 'ingestion');

      expect(result.code).toBe('UNKNOWN_ERROR');
      expect(result.message).not.toContain('duplicate key');
    });

    test('an AppError message is safe by construction and passes through', () => {
      const result = safeErrorMessage(
        new AppError('UNSUPPORTED_FILE_TYPE', 'Only .srt and .vtt are accepted.'),
        'ingestion',
      );

      expect(result.code).toBe('UNSUPPORTED_FILE_TYPE');
      expect(result.message).toBe('Only .srt and .vtt are accepted.');
    });

    test('ordinary Error without code returns generic error', () => {
      const error = new Error('Something went wrong');
      const result = safeErrorMessage(error, 'ingestion');

      expect(result.code).toBe('UNKNOWN_ERROR');
      expect(result.message).toBe('An error occurred during ingestion; see logs for details.');
    });

    test('non-Error value returns generic error', () => {
      const result = safeErrorMessage('random string', 'ingestion');

      expect(result.code).toBe('UNKNOWN_ERROR');
      expect(result.message).toBe('An error occurred during ingestion; see logs for details.');
    });

    test('never returns a stack trace', () => {
      const error = new Error('Database timeout\n    at query (db.ts:42)');
      const result = safeErrorMessage(error, 'ingestion');

      expect(result.message).not.toContain('at query');
      expect(result.message).not.toContain('db.ts');
    });

    test('never returns raw provider response body', () => {
      const providerError = new Error(
        'API error: {"error": {"code": "RATE_LIMIT", "message": "429 Too Many Requests"}}',
      );
      const result = safeErrorMessage(providerError, 'ingestion');

      expect(result.message).not.toContain('RATE_LIMIT');
      expect(result.message).not.toContain('429');
      expect(result.message).not.toContain('API error');
    });
  });
});
