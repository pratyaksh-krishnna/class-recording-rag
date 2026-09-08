import { z } from 'zod';
import { AppError } from '../../errors/AppError';
import { log } from '../../observability/logger';
import type { LLMProvider, LLMRequest, LLMResult } from './provider';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

export interface OpenAILLMProviderOptions {
  apiKey: string;
  model: string;
  /** Defaults to global fetch; exists only so tests never touch the network. */
  fetchImpl?: typeof fetch;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Shape check, not a cast: this body comes from a third party and is
 * untyped. Pulls the first `output_text` part out of the first `message`
 * item — the Responses API's raw JSON has no `output_text` convenience
 * field; that's an SDK addition, not part of the wire format.
 */
function extractOutputText(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { output } = body as { output?: unknown };
  if (!Array.isArray(output)) return undefined;

  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue;
    const { type, content } = item as { type?: unknown; content?: unknown };
    if (type !== 'message' || !Array.isArray(content)) continue;

    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue;
      const { type: partType, text } = part as { type?: unknown; text?: unknown };
      if (partType === 'output_text' && typeof text === 'string') return text;
    }
  }
  return undefined;
}

function extractUsage(body: unknown): { inputTokens: number; outputTokens: number } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { usage } = body as { usage?: unknown };
  if (typeof usage !== 'object' || usage === null) return undefined;
  const { input_tokens, output_tokens } = usage as { input_tokens?: unknown; output_tokens?: unknown };
  if (typeof input_tokens !== 'number' || typeof output_tokens !== 'number') return undefined;
  return { inputTokens: input_tokens, outputTokens: output_tokens };
}

/**
 * A thin client over the Responses API using strict structured output. A
 * strict-mode `json_schema` is still an external claim, not a guarantee, so
 * the parsed output is validated through the caller's Zod schema before it
 * is trusted (spec §8/§9/§13/§14 all rely on this). Never lets a provider
 * response body, the prompt, the completion text, or the API key cross into
 * an AppError message or a log line (spec §16.3, §20, §21) — only status
 * codes and the schema name are safe to record.
 */
export function createOpenAILLMProvider(options: OpenAILLMProviderOptions): LLMProvider {
  const { apiKey, model, fetchImpl = fetch } = options;

  return {
    model,
    async complete<T>(request: LLMRequest<T>): Promise<LLMResult<T>> {
      const jsonSchema = z.toJSONSchema(request.schema);

      let response: Response;
      try {
        response = await fetchImpl(RESPONSES_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            instructions: request.system,
            input: request.user,
            text: {
              format: {
                type: 'json_schema',
                name: request.schemaName,
                strict: true,
                schema: jsonSchema,
              },
            },
            reasoning: { effort: request.reasoningEffort },
          }),
          signal: AbortSignal.timeout(request.timeoutMs),
        });
      } catch (cause) {
        if (isAbortError(cause)) {
          log().warn({ schemaName: request.schemaName }, 'llm request timed out');
          throw new AppError('UPSTREAM_TIMEOUT', 'LLM request timed out.', { cause });
        }
        log().warn({ schemaName: request.schemaName }, 'llm request failed before a response was received');
        throw new AppError('LLM_FAILED', 'LLM request failed.', { cause });
      }

      if (!response.ok) {
        log().warn(
          { status: response.status, schemaName: request.schemaName },
          'llm provider returned a non-2xx status',
        );
        throw new AppError('LLM_FAILED', 'LLM provider returned an error.');
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (cause) {
        log().warn(
          { status: response.status, schemaName: request.schemaName },
          'llm provider returned an unparseable body',
        );
        throw new AppError('LLM_FAILED', 'LLM provider returned a malformed response.', { cause });
      }

      const outputText = extractOutputText(body);
      if (outputText === undefined) {
        log().warn(
          { status: response.status, schemaName: request.schemaName },
          'llm provider response had no output text',
        );
        throw new AppError('LLM_FAILED', 'LLM provider returned no output text.');
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(outputText);
      } catch (cause) {
        log().warn({ schemaName: request.schemaName }, 'llm output text was not valid json');
        throw new AppError('LLM_FAILED', 'LLM output was not valid JSON.', { cause });
      }

      const result = request.schema.safeParse(parsed);
      if (!result.success) {
        log().warn({ schemaName: request.schemaName }, 'llm output failed schema validation');
        throw new AppError('LLM_FAILED', 'LLM output failed schema validation.');
      }

      return { value: result.data, usage: extractUsage(body) };
    },
  };
}
