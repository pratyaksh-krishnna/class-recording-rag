import { test, expect, describe } from 'bun:test';
import { formatTimecode } from '../../../apps/web/src/lib/time';

describe('formatTimecode', () => {
  test('zero ms renders as 00:00', () => {
    expect(formatTimecode(0)).toBe('00:00');
  });

  test('sub-minute values zero-pad seconds', () => {
    expect(formatTimecode(5_000)).toBe('00:05');
    expect(formatTimecode(45_500)).toBe('00:45');
  });

  test('exactly 60 seconds renders as 01:00', () => {
    expect(formatTimecode(60_000)).toBe('01:00');
  });

  test('over an hour promotes to H:MM:SS', () => {
    expect(formatTimecode(3_661_000)).toBe('1:01:01');
    expect(formatTimecode(7_200_000)).toBe('2:00:00');
  });

  test('negative input is treated as zero', () => {
    expect(formatTimecode(-500)).toBe('00:00');
  });
});
