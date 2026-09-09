import { test, expect, describe } from 'bun:test';
import { groupTurns } from '../../../apps/web/src/components/MessageList';
import { evidenceElementId } from '../../../apps/web/src/components/EvidenceEntry';
import { EXAMPLE_QUESTIONS } from '../../../apps/web/src/components/EmptyState';
import type { Turn } from '../../../apps/web/src/hooks/useChat';

describe('groupTurns', () => {
  test('pairs each question with the following assistant turn', () => {
    const turns: Turn[] = [
      { kind: 'question', id: 'q1', text: 'What is a gyroscope?' },
      {
        kind: 'error',
        id: 'e1',
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong on the server. Try again, or rephrase the question.',
        retry: 'Try Again',
        questionText: 'What is a gyroscope?',
      },
    ];

    const groups = groupTurns(turns);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.question.id).toBe('q1');
    expect(groups[0]?.follow?.kind).toBe('error');
  });

  test('a trailing question with no follow still renders', () => {
    const turns: Turn[] = [{ kind: 'question', id: 'q1', text: 'Hello' }];
    const groups = groupTurns(turns);
    expect(groups[0]?.follow).toBeNull();
  });
});

describe('evidenceElementId', () => {
  test('is stable and unique per turn and source', () => {
    expect(evidenceElementId('msg-1', 'SOURCE_1')).toBe('evidence-msg-1-SOURCE_1');
    expect(evidenceElementId('msg-2', 'SOURCE_1')).not.toBe(evidenceElementId('msg-1', 'SOURCE_1'));
  });
});

describe('EXAMPLE_QUESTIONS', () => {
  test('are three factual prompts from the eval corpus', () => {
    expect(EXAMPLE_QUESTIONS).toHaveLength(3);
    expect(EXAMPLE_QUESTIONS).toContain('What is mobile development?');
    expect(EXAMPLE_QUESTIONS).toContain('What is the difference between React Native and Expo?');
    expect(EXAMPLE_QUESTIONS).toContain('What does the gyroscope sensor measure?');
  });
});
