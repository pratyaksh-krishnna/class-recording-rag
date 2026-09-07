import { ConfigError, type Env } from './env.schema';

export interface RagConfig {
  chunking: {
    version: string;
    targetTokens: number;
    minTokens: number;
    maxTokens: number;
    overlapRatio: number;
    gapPreferredMs: number;
    tokenizerEncoding: string;
  };
  retrieval: {
    topKVector: number;
    topKKeyword: number;
    maxQueries: number;
    maxSubQueries: number;
    ftsLanguage: string;
  };
  rrf: { k: number };
  budgets: { contextTokens: number; conversationHistoryTokens: number };
  index: { hnswM: number; hnswEfConstruction: number; hnswEfSearch: number };
  embedding: { model: string; dimensions: number; batchSize: number };
  features: { allowGeneralKnowledgeFallback: boolean; diagnosticsEnabled: boolean };
}

/**
 * Derives the RAG settings from validated env and checks the invariants that
 * Zod cannot express because they relate two variables to each other.
 * Catching these at boot beats discovering them as strange chunk sizes later.
 */
export function buildRagConfig(env: Env): RagConfig {
  if (env.CHUNK_MIN_TOKENS >= env.CHUNK_TARGET_TOKENS) {
    throw new ConfigError(
      `CHUNK_MIN_TOKENS (${env.CHUNK_MIN_TOKENS}) must be below ` +
        `CHUNK_TARGET_TOKENS (${env.CHUNK_TARGET_TOKENS})`,
    );
  }
  if (env.CHUNK_MAX_TOKENS <= env.CHUNK_TARGET_TOKENS) {
    throw new ConfigError(
      `CHUNK_MAX_TOKENS (${env.CHUNK_MAX_TOKENS}) must be above ` +
        `CHUNK_TARGET_TOKENS (${env.CHUNK_TARGET_TOKENS})`,
    );
  }
  // contextualized + rewrite + step-back + subqueries
  const minimumQueryBudget = 3 + env.MAX_SUBQUERIES;
  if (env.MAX_QUERIES < minimumQueryBudget) {
    throw new ConfigError(
      `MAX_QUERIES (${env.MAX_QUERIES}) is too small for MAX_SUBQUERIES ` +
        `(${env.MAX_SUBQUERIES}); it must be at least ${minimumQueryBudget}`,
    );
  }

  return {
    chunking: {
      version: env.CHUNKING_VERSION,
      targetTokens: env.CHUNK_TARGET_TOKENS,
      minTokens: env.CHUNK_MIN_TOKENS,
      maxTokens: env.CHUNK_MAX_TOKENS,
      overlapRatio: env.CHUNK_OVERLAP_RATIO,
      gapPreferredMs: env.CHUNK_GAP_PREFERRED_MS,
      tokenizerEncoding: env.TOKENIZER_ENCODING,
    },
    retrieval: {
      topKVector: env.RETRIEVAL_TOP_K_VECTOR,
      topKKeyword: env.RETRIEVAL_TOP_K_KEYWORD,
      maxQueries: env.MAX_QUERIES,
      maxSubQueries: env.MAX_SUBQUERIES,
      ftsLanguage: env.FTS_LANGUAGE,
    },
    rrf: { k: env.RRF_K },
    budgets: {
      contextTokens: env.CONTEXT_TOKEN_BUDGET,
      conversationHistoryTokens: env.CONVERSATION_HISTORY_TOKEN_BUDGET,
    },
    index: {
      hnswM: env.HNSW_M,
      hnswEfConstruction: env.HNSW_EF_CONSTRUCTION,
      hnswEfSearch: env.HNSW_EF_SEARCH,
    },
    embedding: {
      model: env.EMBEDDING_MODEL,
      dimensions: env.EMBEDDING_DIMENSIONS,
      batchSize: env.EMBEDDING_BATCH_SIZE,
    },
    features: {
      allowGeneralKnowledgeFallback: env.ALLOW_GENERAL_KNOWLEDGE_FALLBACK,
      diagnosticsEnabled: env.DIAGNOSTICS_ENABLED,
    },
  };
}
