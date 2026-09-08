import { test, expect, describe } from 'bun:test';
import { span } from '../../../apps/api/src/observability/trace';

describe('span', () => {
  test('returns the wrapped result', async () => {
    const { result } = await span('unit.test', async () => 42);
    expect(result).toBe(42);
  });

  test('measures a non-negative duration', async () => {
    const { durationMs } = await span('unit.sleep', async () => {
      await Bun.sleep(5);
      return null;
    });
    expect(durationMs).toBeGreaterThanOrEqual(4);
  });

  test('rethrows the original error', async () => {
    const boom = new Error('boom');
    await expect(
      span('unit.fail', async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});
