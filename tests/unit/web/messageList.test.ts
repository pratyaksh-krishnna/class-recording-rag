import { test, expect, describe } from 'bun:test';
import type { Turn } from '../../../apps/web/src/hooks/useChat';
import { groupTurns } from '../../../apps/web/src/components/MessageList';

function question(id: string, text: string): Extract<Turn, { kind: 'question' }> {
  return { kind: 'question', id, text };
}

describe('groupTurns', () => {
  test('pairs each question with the following assistant turn', () => {
    // Built as named locals rather than read back out of the input array:
    // indexing yields `Turn | undefined`, which does not satisfy the narrower
    // question/follow fields on TurnGroup.
    const asked = question('q1', 'What does the gyroscope measure?');
    const pending: Turn = { kind: 'pending', id: 'p1', startedAt: 0 };

    expect(groupTurns([asked, pending])).toEqual([{ question: asked, follow: pending }]);
  });

  test('keeps a trailing question unpaired', () => {
    const asked = question('q1', 'Hello?');
    expect(groupTurns([asked])).toEqual([{ question: asked, follow: null }]);
  });
});
