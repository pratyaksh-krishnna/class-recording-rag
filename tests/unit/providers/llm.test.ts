import { test, expect, describe, mock } from 'bun:test';
import { createOpenAILLMProvider } from '../../../apps/api/src/providers/llm/openai.llm';
import { createScriptedLLMProvider, scriptedError } from '../../../apps/api/src/providers/llm/scripted.mock';
import { isAppError } from '../../../apps/api/src/errors/AppError';
import {
  ContextualizedQuerySchema,
  QueryPlanSchema,
  AnswerSchema,
  EvidenceAssessmentSchema,
} from '../../../apps/api/src/rag/schemas/index';

// Reuses the real spec schemas rather than an ad-hoc z.object here: root-level
// tests have no direct dependency on zod (only apps/api's node_modules does),
// and every other test in this repo resolves zod transitively the same way.

function responsesBody(payload: unknown, usage?: { input_tokens: number; output_tokens: number }): unknown {
  return {
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: JSON.stringify(payload) }],
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createOpenAILLMProvider', () => {
  test('builds a strict json_schema request from the Zod schema', async () => {
    const fetchImpl = mock(async () =>
      jsonResponse(
        responsesBody({ standaloneQuery: 'what is normalization', usedHistory: false, resolvedReferences: [] }),
      ),
    );
    const provider = createOpenAILLMProvider({
      apiKey: 'sk-test',
      model: 'gpt-5.6-luna',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.complete({
      schemaName: 'contextualized_query',
      schema: ContextualizedQuerySchema,
      system: 'system prompt',
      user: 'user prompt',
      reasoningEffort: 'low',
      timeoutMs: 5000,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init.body)) as {
      model: string;
      text: { format: { type: string; name: string; strict: boolean; schema: unknown } };
      reasoning: { effort: string };
    };
    expect(body.model).toBe('gpt-5.6-luna');
    expect(body.text.format.type).toBe('json_schema');
    expect(body.text.format.name).toBe('contextualized_query');
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.schema).toBeDefined();
    expect(body.reasoning.effort).toBe('low');
    // Authorization must carry the key but the key must never leak into a thrown error.
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
  });

  test('returns the validated value and usage on success', async () => {
    const fetchImpl = mock(async () =>
      jsonResponse(
        responsesBody(
          { standaloneQuery: 'what is normalization', usedHistory: true, resolvedReferences: ['it -> normalization'] },
          { input_tokens: 12, output_tokens: 34 },
        ),
      ),
    );
    const provider = createOpenAILLMProvider({
      apiKey: 'sk-test',
      model: 'gpt-5.6-luna',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.complete({
      schemaName: 'contextualized_query',
      schema: ContextualizedQuerySchema,
      system: 'system',
      user: 'user',
      reasoningEffort: 'low',
      timeoutMs: 5000,
    });

    expect(result.value).toEqual({
      standaloneQuery: 'what is normalization',
      usedHistory: true,
      resolvedReferences: ['it -> normalization'],
    });
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
  });

  test('a response violating the schema raises LLM_FAILED without leaking response text', async () => {
    const secretMarker = 'super-secret-upstream-detail-must-not-leak';
    // standaloneQuery below the schema's min(3) — violates ContextualizedQuerySchema.
    const fetchImpl = mock(async () =>
      jsonResponse(responsesBody({ standaloneQuery: 'ok', usedHistory: false, resolvedReferences: [secretMarker] })),
    );
    const provider = createOpenAILLMProvider({
      apiKey: 'sk-test',
      model: 'gpt-5.6-luna',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    let caught: unknown;
    try {
      await provider.complete({
        schemaName: 'contextualized_query',
        schema: ContextualizedQuerySchema,
        system: 'system',
        user: 'user',
        reasoningEffort: 'low',
        timeoutMs: 5000,
      });
    } catch (error) {
      caught = error;
    }

    expect(isAppError(caught)).toBe(true);
    expect((caught as { code?: string }).code).toBe('LLM_FAILED');
    expect((caught as Error).message).not.toContain(secretMarker);
  });

  test('unparseable output text raises LLM_FAILED without leaking the text', async () => {
    const secretMarker = 'not-json-at-all-secret-marker';
    const fetchImpl = mock(async () =>
      jsonResponse({
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: secretMarker }] }],
      }),
    );
    const provider = createOpenAILLMProvider({
      apiKey: 'sk-test',
      model: 'gpt-5.6-luna',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    let caught: unknown;
    try {
      await provider.complete({
        schemaName: 'contextualized_query',
        schema: ContextualizedQuerySchema,
        system: 'system',
        user: 'user',
        reasoningEffort: 'low',
        timeoutMs: 5000,
      });
    } catch (error) {
      caught = error;
    }

    expect(isAppError(caught)).toBe(true);
    expect((caught as { code?: string }).code).toBe('LLM_FAILED');
    expect((caught as Error).message).not.toContain(secretMarker);
  });

  test('a non-2xx response raises LLM_FAILED without leaking the response body', async () => {
    const secretBody = 'internal upstream diagnostic detail that must never reach the client';
    const fetchImpl = mock(async () => new Response(secretBody, { status: 500 }));
    const provider = createOpenAILLMProvider({
      apiKey: 'sk-test',
      model: 'gpt-5.6-luna',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    let caught: unknown;
    try {
      await provider.complete({
        schemaName: 'contextualized_query',
        schema: ContextualizedQuerySchema,
        system: 'system',
        user: 'user',
        reasoningEffort: 'low',
        timeoutMs: 5000,
      });
    } catch (error) {
      caught = error;
    }

    expect(isAppError(caught)).toBe(true);
    expect((caught as { code?: string }).code).toBe('LLM_FAILED');
    expect((caught as Error).message).not.toContain(secretBody);
  });

  test('an AbortError from fetchImpl raises UPSTREAM_TIMEOUT', async () => {
    const fetchImpl = mock(async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      throw abortError;
    });
    const provider = createOpenAILLMProvider({
      apiKey: 'sk-test',
      model: 'gpt-5.6-luna',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    let caught: unknown;
    try {
      await provider.complete({
        schemaName: 'contextualized_query',
        schema: ContextualizedQuerySchema,
        system: 'system',
        user: 'user',
        reasoningEffort: 'low',
        timeoutMs: 5000,
      });
    } catch (error) {
      caught = error;
    }

    expect(isAppError(caught)).toBe(true);
    expect((caught as { code?: string }).code).toBe('UPSTREAM_TIMEOUT');
  });
});

describe('createScriptedLLMProvider', () => {
  test('returns queued values in order per schemaName', async () => {
    const provider = createScriptedLLMProvider({
      query_plan: [
        { contextualizedQuery: 'first query', rewrittenQuery: null, stepBackQuery: null, subQueries: [], rationale: '' },
        { contextualizedQuery: 'second query', rewrittenQuery: null, stepBackQuery: null, subQueries: [], rationale: '' },
      ],
    });

    const first = await provider.complete({
      schemaName: 'query_plan',
      schema: QueryPlanSchema,
      system: 's',
      user: 'u1',
      reasoningEffort: 'low',
      timeoutMs: 1000,
    });
    const second = await provider.complete({
      schemaName: 'query_plan',
      schema: QueryPlanSchema,
      system: 's',
      user: 'u2',
      reasoningEffort: 'low',
      timeoutMs: 1000,
    });

    expect(first.value.contextualizedQuery).toBe('first query');
    expect(second.value.contextualizedQuery).toBe('second query');
  });

  test('records calls with schemaName and prompts so a skipped step is assertable', async () => {
    const provider = createScriptedLLMProvider({
      answer: [{ answer: 'the answer', citedSourceIds: [], usedGeneralKnowledge: false }],
    });

    await provider.complete({
      schemaName: 'answer',
      schema: AnswerSchema,
      system: 'sys prompt',
      user: 'user prompt',
      reasoningEffort: 'medium',
      timeoutMs: 1000,
    });

    expect(provider.calls).toEqual([{ schemaName: 'answer', system: 'sys prompt', user: 'user prompt' }]);
    // e.g. a test asserting the contextualizer was skipped on a first turn:
    expect(provider.calls.some((call) => call.schemaName === 'contextualized_query')).toBe(false);
  });

  test('an exhausted queue throws a clear test-facing error', async () => {
    const provider = createScriptedLLMProvider({
      query_plan: [
        { contextualizedQuery: 'only one', rewrittenQuery: null, stepBackQuery: null, subQueries: [], rationale: '' },
      ],
    });
    await provider.complete({
      schemaName: 'query_plan',
      schema: QueryPlanSchema,
      system: 's',
      user: 'u',
      reasoningEffort: 'low',
      timeoutMs: 1000,
    });

    await expect(
      provider.complete({
        schemaName: 'query_plan',
        schema: QueryPlanSchema,
        system: 's',
        user: 'u',
        reasoningEffort: 'low',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/query_plan/);
  });

  test('a scripted error entry is thrown', async () => {
    const boom = new Error('boom');
    const provider = createScriptedLLMProvider({ judge: [scriptedError(boom)] });

    await expect(
      provider.complete({
        schemaName: 'judge',
        schema: EvidenceAssessmentSchema,
        system: 's',
        user: 'u',
        reasoningEffort: 'medium',
        timeoutMs: 1000,
      }),
    ).rejects.toBe(boom);
  });
});
