import { test, expect, describe } from 'bun:test';
import { contextualize } from '../../../apps/api/src/rag/contextualizer';
import { createScriptedLLMProvider, scriptedError } from '../../../apps/api/src/providers/llm/scripted.mock';
import type { HistoryMessage } from '../../../apps/api/src/rag/conversation/history';

function deps(provider: ReturnType<typeof createScriptedLLMProvider>) {
  return { llm: provider, reasoningEffort: 'low' as const, timeoutMs: 5000 };
}

describe('contextualize', () => {
  test('first turn (no history) skips the LLM entirely', async () => {
    const provider = createScriptedLLMProvider({});

    const result = await contextualize(deps(provider), { question: 'what is normalization', history: [] });

    expect(result).toEqual({
      standaloneQuery: 'what is normalization',
      usedHistory: false,
      skipped: true,
      resolvedReferences: [],
    });
    expect(provider.calls).toEqual([]);
  });

  test('a follow-up resolves a pronoun against history via the LLM', async () => {
    const history: HistoryMessage[] = [
      { role: 'user', content: 'what is database normalization' },
      { role: 'assistant', content: 'Normalization is the process of organizing data to reduce redundancy.' },
    ];
    const provider = createScriptedLLMProvider({
      contextualized_query: [
        {
          standaloneQuery: 'what are the benefits of database normalization',
          usedHistory: true,
          resolvedReferences: ['it -> database normalization'],
        },
      ],
    });

    const result = await contextualize(deps(provider), { question: 'what are the benefits of it', history });

    expect(result).toEqual({
      standaloneQuery: 'what are the benefits of database normalization',
      usedHistory: true,
      skipped: false,
      resolvedReferences: ['it -> database normalization'],
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.schemaName).toBe('contextualized_query');
  });

  test('provider throwing falls back to the raw question without throwing', async () => {
    const history: HistoryMessage[] = [
      { role: 'user', content: 'what is normalization' },
      { role: 'assistant', content: 'It is a process for organizing data.' },
    ];
    const provider = createScriptedLLMProvider({
      contextualized_query: [scriptedError(new Error('upstream exploded'))],
    });

    const result = await contextualize(deps(provider), { question: 'what are the benefits of it', history });

    expect(result).toEqual({
      standaloneQuery: 'what are the benefits of it',
      usedHistory: false,
      skipped: false,
      resolvedReferences: [],
    });
  });

  test('the prompt sent to the provider includes the history and the question', async () => {
    const history: HistoryMessage[] = [
      { role: 'user', content: 'what is database normalization' },
      { role: 'assistant', content: 'Normalization organizes data to reduce redundancy.' },
    ];
    const provider = createScriptedLLMProvider({
      contextualized_query: [
        { standaloneQuery: 'benefits of database normalization', usedHistory: true, resolvedReferences: [] },
      ],
    });

    await contextualize(deps(provider), { question: 'what are the benefits of it', history });

    const call = provider.calls[0]!;
    expect(call.user).toContain('database normalization');
    expect(call.user).toContain('what are the benefits of it');
  });
});
