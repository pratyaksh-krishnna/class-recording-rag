import { test, expect, describe } from 'bun:test';
import { planQueries } from '../../../apps/api/src/rag/planner';
import { createScriptedLLMProvider, scriptedError } from '../../../apps/api/src/providers/llm/scripted.mock';
import type { HistoryMessage } from '../../../apps/api/src/rag/conversation/history';

const limits = { maxQueries: 6, maxSubQueries: 3 };

function deps(provider: ReturnType<typeof createScriptedLLMProvider>) {
  return { llm: provider, reasoningEffort: 'low' as const, timeoutMs: 5000, limits };
}

describe('planQueries', () => {
  test('a valid plan normalizes to labelled queries with the contextualized query first', async () => {
    const provider = createScriptedLLMProvider({
      query_plan: [
        {
          contextualizedQuery: 'what is database normalization',
          rewrittenQuery: 'explain normalization in relational databases',
          stepBackQuery: 'what are database design principles',
          subQueries: ['what is 1NF', 'what is 2NF'],
          rationale: 'broad topic, broken into normal forms',
        },
      ],
    });

    const result = await planQueries(deps(provider), {
      standaloneQuery: 'what is database normalization',
      history: [],
    });

    expect(result.queries).toEqual([
      { label: 'contextualized', text: 'what is database normalization' },
      { label: 'rewritten', text: 'explain normalization in relational databases' },
      { label: 'step_back', text: 'what are database design principles' },
      { label: 'sub_query_1', text: 'what is 1NF' },
      { label: 'sub_query_2', text: 'what is 2NF' },
    ]);
    expect(result.rationale).toBe('broad topic, broken into normal forms');
  });

  test('a throwing provider falls back to a single-query plan', async () => {
    const provider = createScriptedLLMProvider({
      query_plan: [scriptedError(new Error('upstream exploded'))],
    });

    const result = await planQueries(deps(provider), { standaloneQuery: 'what is normalization', history: [] });

    expect(result.queries).toEqual([{ label: 'contextualized', text: 'what is normalization' }]);
  });

  test('garbage output that violates business rules is still normalized safely (not force-fed everywhere)', async () => {
    const provider = createScriptedLLMProvider({
      query_plan: [
        {
          contextualizedQuery: 'simple question',
          rewrittenQuery: null,
          stepBackQuery: null,
          subQueries: [],
          rationale: 'trivial question needs no transformation',
        },
      ],
    });

    const result = await planQueries(deps(provider), { standaloneQuery: 'simple question', history: [] });

    expect(result.queries).toEqual([{ label: 'contextualized', text: 'simple question' }]);
  });

  test('more than 3 subqueries are truncated', async () => {
    const provider = createScriptedLLMProvider({
      query_plan: [
        {
          contextualizedQuery: 'what is normalization',
          rewrittenQuery: null,
          stepBackQuery: null,
          subQueries: ['sub one here', 'sub two here', 'sub three here', 'sub four here', 'sub five here'],
          rationale: 'many facets',
        },
      ],
    });

    const result = await planQueries(deps(provider), { standaloneQuery: 'what is normalization', history: [] });

    const subQueryLabels = result.queries.filter((q) => q.label.startsWith('sub_query_'));
    expect(subQueryLabels).toHaveLength(3);
  });

  test('duplicates (case-insensitive) are dropped', async () => {
    const provider = createScriptedLLMProvider({
      query_plan: [
        {
          contextualizedQuery: 'what is normalization',
          rewrittenQuery: 'WHAT IS NORMALIZATION',
          stepBackQuery: null,
          subQueries: [],
          rationale: 'duplicate rewrite',
        },
      ],
    });

    const result = await planQueries(deps(provider), { standaloneQuery: 'what is normalization', history: [] });

    expect(result.queries).toEqual([{ label: 'contextualized', text: 'what is normalization' }]);
  });

  test('the prompt sent to the provider does not contain a class or module catalogue', async () => {
    const provider = createScriptedLLMProvider({
      query_plan: [
        {
          contextualizedQuery: 'what is normalization',
          rewrittenQuery: null,
          stepBackQuery: null,
          subQueries: [],
          rationale: 'simple',
        },
      ],
    });

    await planQueries(deps(provider), { standaloneQuery: 'what is normalization', history: [] });

    const call = provider.calls[0]!;
    const fullPrompt = `${call.system}\n${call.user}`;
    // No course-navigation data (module/class titles or ids) is ever embedded —
    // the planner's job is query formulation, not course navigation (spec §9).
    expect(fullPrompt).not.toMatch(/module\s+\d/i);
    expect(fullPrompt).not.toMatch(/class\s+\d/i);
    expect(fullPrompt.toLowerCase()).not.toContain('gyroscope');
  });

  test('history is included in the prompt when present', async () => {
    const history: HistoryMessage[] = [
      { role: 'user', content: 'what is normalization' },
      { role: 'assistant', content: 'It organizes data to reduce redundancy.' },
    ];
    const provider = createScriptedLLMProvider({
      query_plan: [
        {
          contextualizedQuery: 'what are the benefits of normalization',
          rewrittenQuery: null,
          stepBackQuery: null,
          subQueries: [],
          rationale: 'follow-up',
        },
      ],
    });

    await planQueries(deps(provider), { standaloneQuery: 'what are the benefits of normalization', history });

    const call = provider.calls[0]!;
    expect(call.user).toContain('reduce redundancy');
  });
});
