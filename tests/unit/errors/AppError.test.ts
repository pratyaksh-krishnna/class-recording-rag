import { test, expect, describe } from 'bun:test';
import { AppError, toErrorBody } from '../../../apps/api/src/errors/AppError';

describe('AppError', () => {
  test('maps each code to its documented HTTP status', () => {
    expect(new AppError('VALIDATION_ERROR', 'bad').statusCode).toBe(400);
    expect(new AppError('NOT_FOUND', 'nope').statusCode).toBe(404);
    expect(new AppError('COHORT_NOT_FOUND', 'nope').statusCode).toBe(404);
    expect(new AppError('CONVERSATION_NOT_FOUND', 'nope').statusCode).toBe(404);
    expect(new AppError('UNSUPPORTED_FILE_TYPE', 'nope').statusCode).toBe(415);
    expect(new AppError('FILE_TOO_LARGE', 'nope').statusCode).toBe(413);
    expect(new AppError('RETRIEVAL_FAILED', 'nope').statusCode).toBe(503);
    expect(new AppError('LLM_FAILED', 'nope').statusCode).toBe(503);
    expect(new AppError('UPSTREAM_TIMEOUT', 'nope').statusCode).toBe(504);
    expect(new AppError('INTERNAL_ERROR', 'nope').statusCode).toBe(500);
  });

  test('preserves the cause for logging without exposing it', () => {
    const cause = new Error('connection refused');
    const error = new AppError('RETRIEVAL_FAILED', 'Retrieval failed', { cause });
    expect(error.cause).toBe(cause);
  });
});

describe('toErrorBody', () => {
  test('serializes an AppError with its code, message and requestId', () => {
    const { status, body } = toErrorBody(
      new AppError('VALIDATION_ERROR', 'question is required', {
        details: { field: 'question' },
      }),
      'req-1',
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('question is required');
    expect(body.error.requestId).toBe('req-1');
    expect(body.error.details).toEqual({ field: 'question' });
  });

  test('converts an unknown error into a generic 500', () => {
    const { status, body } = toErrorBody(new Error('pg: password authentication failed'), 'req-2');
    expect(status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('An unexpected error occurred.');
  });

  test('never leaks a stack trace or internal message to the client', () => {
    const internal = new Error('DATABASE_URL=postgres://rag:secret@host/db is unreachable');
    internal.stack = 'Error: secret stack\n    at somewhere';
    const { body } = toErrorBody(internal, 'req-3');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('stack');
    expect(serialized).not.toContain('postgres://');
  });

  test('handles a thrown non-Error value', () => {
    const { status, body } = toErrorBody('just a string', 'req-4');
    expect(status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});
