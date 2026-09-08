import type { z } from 'zod';

export interface LLMRequest<T> {
  /** json_schema name sent to the provider, e.g. 'query_plan'. Also used as a safe log field. */
  schemaName: string;
  /** Converted to JSON Schema by the provider, then used again to validate the parsed output. */
  schema: z.ZodType<T>;
  system: string;
  user: string;
  reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs: number;
}

export interface LLMResult<T> {
  value: T;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LLMProvider {
  readonly model: string;
  complete<T>(request: LLMRequest<T>): Promise<LLMResult<T>>;
}
