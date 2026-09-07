import { test, expect, describe } from 'bun:test';
import { loadEnv, ConfigError } from '../../../apps/api/src/config/env.schema';

const minimal = {
  DATABASE_URL: 'postgres://rag:rag@localhost:5432/rag',
  OPENAI_API_KEY: 'sk-test',
};

describe('loadEnv', () => {
  test('applies documented defaults', () => {
    const env = loadEnv(minimal);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.RRF_K).toBe(60);
    expect(env.CONTEXT_TOKEN_BUDGET).toBe(8000);
    expect(env.CONVERSATION_HISTORY_TOKEN_BUDGET).toBe(1500);
    expect(env.EMBEDDING_DIMENSIONS).toBe(1536);
    expect(env.CHUNK_TARGET_TOKENS).toBe(500);
    expect(env.MAX_QUERIES).toBe(6);
    expect(env.LLM_MODEL).toBe('gpt-5.6-luna');
  });

  test('coerces numeric strings to numbers', () => {
    const env = loadEnv({ ...minimal, PORT: '8080', RRF_K: '20' });
    expect(env.PORT).toBe(8080);
    expect(env.RRF_K).toBe(20);
  });

  test('coerces boolean strings', () => {
    expect(loadEnv({ ...minimal, DIAGNOSTICS_ENABLED: 'true' }).DIAGNOSTICS_ENABLED).toBe(true);
    expect(loadEnv({ ...minimal, DIAGNOSTICS_ENABLED: 'false' }).DIAGNOSTICS_ENABLED).toBe(false);
    expect(loadEnv(minimal).ALLOW_GENERAL_KNOWLEDGE_FALLBACK).toBe(true);
  });

  test('defaults booleans to real booleans when the key is absent', () => {
    const env = loadEnv(minimal);
    expect(env.DIAGNOSTICS_ENABLED).toBe(false);
    expect(typeof env.DIAGNOSTICS_ENABLED).toBe('boolean');
    expect(typeof env.ALLOW_GENERAL_KNOWLEDGE_FALLBACK).toBe('boolean');
  });

  test('fails fast when a required secret is missing', () => {
    expect(() => loadEnv({ DATABASE_URL: minimal.DATABASE_URL })).toThrow(ConfigError);
    expect(() => loadEnv({ OPENAI_API_KEY: minimal.OPENAI_API_KEY })).toThrow(ConfigError);
  });

  test('names the offending variable in the error message', () => {
    try {
      loadEnv({ DATABASE_URL: minimal.DATABASE_URL });
      throw new Error('expected loadEnv to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain('OPENAI_API_KEY');
    }
  });

  test('rejects a non-numeric port instead of silently defaulting', () => {
    expect(() => loadEnv({ ...minimal, PORT: 'not-a-port' })).toThrow(ConfigError);
  });

  test('rejects an unknown reasoning effort', () => {
    expect(() =>
      loadEnv({ ...minimal, LLM_REASONING_EFFORT_JUDGE: 'extreme' }),
    ).toThrow(ConfigError);
  });
});
