import { test, expect, describe } from 'bun:test';
import { createTokenizer } from '../../../apps/api/src/ingestion/tokenizer/tokenizer';

describe('tokenizer', () => {
  test('counts real BPE tokens, not characters', () => {
    const tokenizer = createTokenizer('o200k_base');
    // 33 characters, far fewer tokens — a character-length estimate cannot pass this.
    const text = 'Hello everyone, welcome to class.';
    expect(text.length).toBe(33);
    expect(tokenizer.count(text)).toBe(7);
  });

  test('is deterministic across calls and instances', () => {
    const text = 'Cosine similarity is just a normalized dot product.';
    const a = createTokenizer('o200k_base');
    const b = createTokenizer('o200k_base');
    expect(a.count(text)).toBe(b.count(text));
    expect(a.count(text)).toBe(a.count(text));
  });

  test('counts the empty string as zero tokens', () => {
    expect(createTokenizer('o200k_base').count('')).toBe(0);
  });

  test('exposes the encoding name for persistence', () => {
    expect(createTokenizer('cl100k_base').name).toBe('cl100k_base');
  });

  test('rejects an unknown encoding as a configuration error', () => {
    expect(() => createTokenizer('not_an_encoding')).toThrow(/not_an_encoding/);
  });
});
