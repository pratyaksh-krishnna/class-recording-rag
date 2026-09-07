import { test, expect, describe } from 'bun:test';
import { loadEnv } from '../../../apps/api/src/config/env.schema';
import { buildRagConfig } from '../../../apps/api/src/config/rag';

const base = {
  DATABASE_URL: 'postgres://rag:rag@localhost:5432/rag',
  OPENAI_API_KEY: 'sk-test',
};

describe('buildRagConfig', () => {
  test('reads RRF k from configuration rather than hardcoding it', () => {
    expect(buildRagConfig(loadEnv(base)).rrf.k).toBe(60);
    expect(buildRagConfig(loadEnv({ ...base, RRF_K: '17' })).rrf.k).toBe(17);
  });

  test('groups chunking settings from the spec', () => {
    const cfg = buildRagConfig(loadEnv(base));
    expect(cfg.chunking).toEqual({
      version: 'v1',
      targetTokens: 500,
      minTokens: 350,
      maxTokens: 650,
      overlapRatio: 0.125,
      gapPreferredMs: 2000,
      tokenizerEncoding: 'o200k_base',
    });
  });

  test('rejects a chunk range that is not min < target < max', () => {
    expect(() =>
      buildRagConfig(loadEnv({ ...base, CHUNK_MIN_TOKENS: '700' })),
    ).toThrow(/CHUNK_MIN_TOKENS/);

    expect(() =>
      buildRagConfig(loadEnv({ ...base, CHUNK_MAX_TOKENS: '400' })),
    ).toThrow(/CHUNK_MAX_TOKENS/);
  });

  test('rejects more subqueries than the total query budget allows', () => {
    expect(() =>
      buildRagConfig(loadEnv({ ...base, MAX_QUERIES: '2', MAX_SUBQUERIES: '3' })),
    ).toThrow(/MAX_QUERIES/);
  });

  test('exposes the general-knowledge fallback as a feature flag', () => {
    expect(buildRagConfig(loadEnv(base)).features.allowGeneralKnowledgeFallback).toBe(true);
    expect(
      buildRagConfig(loadEnv({ ...base, ALLOW_GENERAL_KNOWLEDGE_FALLBACK: 'false' }))
        .features.allowGeneralKnowledgeFallback,
    ).toBe(false);
  });
});
