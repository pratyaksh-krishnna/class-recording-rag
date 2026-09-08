import { test, expect, describe } from 'bun:test';
import {
  getRequestContext,
  runWithRequestContext,
} from '../../../apps/api/src/observability/context';

describe('request context', () => {
  test('is undefined outside a run', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  test('is readable inside a run', () => {
    runWithRequestContext({ requestId: 'req-1', cohortId: 'cohort-1' }, () => {
      expect(getRequestContext()).toEqual({ requestId: 'req-1', cohortId: 'cohort-1' });
    });
  });

  test('survives an await boundary', async () => {
    await runWithRequestContext({ requestId: 'req-2' }, async () => {
      await Promise.resolve();
      expect(getRequestContext()?.requestId).toBe('req-2');
    });
  });

  test('does not leak between sibling runs', () => {
    runWithRequestContext({ requestId: 'a' }, () => {
      expect(getRequestContext()?.requestId).toBe('a');
    });
    runWithRequestContext({ requestId: 'b' }, () => {
      expect(getRequestContext()?.requestId).toBe('b');
    });
    expect(getRequestContext()).toBeUndefined();
  });
});
