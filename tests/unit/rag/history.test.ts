import { test, expect, describe } from 'bun:test';
import { selectHistory, type HistoryMessage } from '../../../apps/api/src/rag/conversation/history';
import type { Tokenizer } from '../../../apps/api/src/ingestion/tokenizer/tokenizer';

/**
 * One token per whitespace-delimited word. Deterministic and legible, which
 * lets these tests state exact sizes — mirrors the fake used in the chunker
 * suite so budget math here is equally exact.
 */
const wordTokenizer: Tokenizer = {
  name: 'test-words',
  count: (text) => (text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length),
};

function user(content: string): HistoryMessage {
  return { role: 'user', content };
}

function assistant(content: string): HistoryMessage {
  return { role: 'assistant', content };
}

describe('selectHistory', () => {
  test('returns everything when it fits comfortably inside the budget', () => {
    const messages = [user('one two'), assistant('three four')];
    const result = selectHistory(messages, 100, wordTokenizer);
    expect(result).toEqual(messages);
  });

  test('result never exceeds the token budget', () => {
    const messages = [
      user('a b c d e'),
      assistant('f g h i j'),
      user('k l m n o'),
      assistant('p q r s t'),
      user('u v w x y'),
      assistant('z aa bb cc dd'),
    ];
    const result = selectHistory(messages, 12, wordTokenizer);
    const total = result.reduce((sum, m) => sum + wordTokenizer.count(m.content), 0);
    expect(total).toBeLessThanOrEqual(12);
  });

  test('drops the oldest pair first, keeping a contiguous recent suffix', () => {
    const messages = [
      user('one two'), // pair 1: 2 + 2 = 4 tokens
      assistant('three four'),
      user('five six'), // pair 2: 2 + 2 = 4 tokens
      assistant('seven eight'),
      user('nine ten'), // pair 3: 2 + 2 = 4 tokens
      assistant('eleven twelve'),
    ];
    // Budget fits exactly the newest two pairs (8 tokens) but not all three (12).
    const result = selectHistory(messages, 8, wordTokenizer);
    expect(result).toEqual(messages.slice(2));
  });

  test('never returns an assistant message whose preceding user message was dropped', () => {
    const messages = [
      user('one two three four five'), // 5 tokens — the pair that should get dropped
      assistant('six seven eight nine ten'), // 5 tokens
      user('eleven'), // 1 token
      assistant('twelve'), // 1 token
    ];
    // Budget fits the newest pair (2) but not the older pair too (12).
    const result = selectHistory(messages, 5, wordTokenizer);
    expect(result).toEqual([user('eleven'), assistant('twelve')]);
    // No assistant message appears without its own preceding user message.
    for (let i = 0; i < result.length; i++) {
      const message = result[i];
      if (message !== undefined && message.role === 'assistant') {
        const prev = result[i - 1];
        expect(prev?.role).toBe('user');
      }
    }
  });

  test('returns messages in chronological (oldest-first) order', () => {
    const messages = [
      user('one'),
      assistant('two'),
      user('three'),
      assistant('four'),
    ];
    const result = selectHistory(messages, 100, wordTokenizer);
    expect(result.map((m) => m.content)).toEqual(['one', 'two', 'three', 'four']);
  });

  test('strips [SOURCE_N] markers from assistant content but leaves user content untouched', () => {
    const messages = [
      user('What is the capital [SOURCE_2] of France?'),
      assistant('The capital is Paris [SOURCE_2].'),
    ];
    const result = selectHistory(messages, 100, wordTokenizer);
    expect(result[0]?.content).toBe('What is the capital [SOURCE_2] of France?');
    expect(result[1]?.content).not.toMatch(/\[SOURCE_\d+\]/);
    expect(result[1]?.content).toBe('The capital is Paris.');
  });

  test('a single message larger than the whole budget yields []', () => {
    const messages = [user('one two three four five')];
    const result = selectHistory(messages, 3, wordTokenizer);
    expect(result).toEqual([]);
  });

  test('empty input yields []', () => {
    expect(selectHistory([], 1500, wordTokenizer)).toEqual([]);
  });

  test('an odd-length history ending in an unanswered user message is not dropped wrongly', () => {
    const messages = [
      user('one'),
      assistant('two'),
      user('three'), // current turn — no assistant reply yet
    ];
    const result = selectHistory(messages, 100, wordTokenizer);
    expect(result).toEqual(messages);
  });

  test('an oversized trailing unanswered user message is dropped like any other unit too big to fit', () => {
    const messages = [
      user('one'),
      assistant('two'),
      user('three four five six seven'), // current turn, 5 tokens
    ];
    const result = selectHistory(messages, 4, wordTokenizer);
    // The trailing 5-token unit alone exceeds the 4-token budget, so nothing fits.
    expect(result).toEqual([]);
  });
});
