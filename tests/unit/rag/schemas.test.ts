import { test, expect, describe } from 'bun:test';
import {
  ContextualizedQuerySchema,
  QueryPlanSchema,
  EvidenceAssessmentSchema,
  AnswerSchema,
} from '../../../apps/api/src/rag/schemas/index';
import {
  normalizeQueryPlan,
  fallbackPlan,
  normalizeAssessment,
} from '../../../apps/api/src/rag/schemas/normalize';
import type { QueryPlan, EvidenceAssessment } from '../../../apps/api/src/rag/schemas/index';

describe('ContextualizedQuerySchema', () => {
  test('accepts a valid payload', () => {
    const result = ContextualizedQuerySchema.safeParse({
      standaloneQuery: 'what is normalization',
      usedHistory: true,
      resolvedReferences: ['it -> normalization'],
    });
    expect(result.success).toBe(true);
  });

  test('rejects a malformed payload', () => {
    const result = ContextualizedQuerySchema.safeParse({
      standaloneQuery: 'hi', // below min(3)
      usedHistory: 'yes', // wrong type
      resolvedReferences: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('QueryPlanSchema', () => {
  test('accepts a valid payload with nulls and empty subqueries', () => {
    const result = QueryPlanSchema.safeParse({
      contextualizedQuery: 'what is normalization',
      rewrittenQuery: null,
      stepBackQuery: null,
      subQueries: [],
      rationale: 'simple question, no transformation needed',
    });
    expect(result.success).toBe(true);
  });

  test('accepts a fully populated valid payload', () => {
    const result = QueryPlanSchema.safeParse({
      contextualizedQuery: 'what is database normalization',
      rewrittenQuery: 'explain normalization in relational databases',
      stepBackQuery: 'what are database design principles',
      subQueries: ['what is 1NF', 'what is 2NF', 'what is 3NF'],
      rationale: 'broad topic, broken into normal forms',
    });
    expect(result.success).toBe(true);
  });

  test('rejects a payload with more than 3 subqueries', () => {
    const result = QueryPlanSchema.safeParse({
      contextualizedQuery: 'what is normalization',
      rewrittenQuery: null,
      stepBackQuery: null,
      subQueries: ['a1', 'b2', 'c3', 'd4'],
      rationale: 'too many',
    });
    expect(result.success).toBe(false);
  });

  test('rejects a payload with a too-short contextualizedQuery', () => {
    const result = QueryPlanSchema.safeParse({
      contextualizedQuery: 'ab',
      rewrittenQuery: null,
      stepBackQuery: null,
      subQueries: [],
      rationale: 'x',
    });
    expect(result.success).toBe(false);
  });
});

describe('EvidenceAssessmentSchema', () => {
  test('accepts a valid payload for every verdict', () => {
    for (const verdict of ['sufficient', 'partial', 'insufficient', 'conflicting'] as const) {
      const result = EvidenceAssessmentSchema.safeParse({
        verdict,
        rationale: 'because the evidence says so',
        supportingSourceIds: ['SOURCE_1'],
        conflictingSourceIds: [],
        missingInformation: [],
      });
      expect(result.success).toBe(true);
    }
  });

  test('rejects an invalid verdict', () => {
    const result = EvidenceAssessmentSchema.safeParse({
      verdict: 'maybe',
      rationale: 'x',
      supportingSourceIds: [],
      conflictingSourceIds: [],
      missingInformation: [],
    });
    expect(result.success).toBe(false);
  });

  test('rejects too many supportingSourceIds', () => {
    const result = EvidenceAssessmentSchema.safeParse({
      verdict: 'sufficient',
      rationale: 'x',
      supportingSourceIds: Array.from({ length: 21 }, (_, i) => `SOURCE_${i}`),
      conflictingSourceIds: [],
      missingInformation: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('AnswerSchema', () => {
  test('accepts a valid payload', () => {
    const result = AnswerSchema.safeParse({
      answer: 'Normalization is [SOURCE_1] the process of...',
      citedSourceIds: ['SOURCE_1'],
      usedGeneralKnowledge: false,
    });
    expect(result.success).toBe(true);
  });

  test('rejects an empty answer', () => {
    const result = AnswerSchema.safeParse({
      answer: '',
      citedSourceIds: [],
      usedGeneralKnowledge: false,
    });
    expect(result.success).toBe(false);
  });

  test('rejects an answer over 8000 characters', () => {
    const result = AnswerSchema.safeParse({
      answer: 'a'.repeat(8001),
      citedSourceIds: [],
      usedGeneralKnowledge: false,
    });
    expect(result.success).toBe(false);
  });
});

const LIMITS = { maxQueries: 6, maxSubQueries: 3 };

function plan(overrides: Partial<QueryPlan> = {}): QueryPlan {
  return {
    contextualizedQuery: 'what is normalization',
    rewrittenQuery: null,
    stepBackQuery: null,
    subQueries: [],
    rationale: '',
    ...overrides,
  };
}

describe('normalizeQueryPlan', () => {
  test('keeps the contextualized query first and always present', () => {
    const result = normalizeQueryPlan(plan(), 'what is normalization', LIMITS);
    expect(result[0]).toEqual({ label: 'contextualized', text: 'what is normalization' });
  });

  test('drops empty and whitespace-only queries', () => {
    const result = normalizeQueryPlan(
      plan({ rewrittenQuery: '   ', stepBackQuery: '', subQueries: ['  ', 'valid subquery here'] }),
      'what is normalization',
      LIMITS,
    );
    expect(result.map((q) => q.label)).toEqual(['contextualized', 'sub_query_1']);
    expect(result[1]).toEqual({ label: 'sub_query_1', text: 'valid subquery here' });
  });

  test('case-insensitively dedupes against the contextualized query', () => {
    const result = normalizeQueryPlan(
      plan({ rewrittenQuery: 'WHAT IS NORMALIZATION' }),
      'what is normalization',
      LIMITS,
    );
    expect(result).toEqual([{ label: 'contextualized', text: 'what is normalization' }]);
  });

  test('case-insensitively dedupes duplicate candidates against each other', () => {
    const result = normalizeQueryPlan(
      plan({
        rewrittenQuery: 'duplicate text',
        stepBackQuery: 'Duplicate Text',
        subQueries: ['duplicate TEXT'],
      }),
      'what is normalization',
      LIMITS,
    );
    expect(result).toEqual([
      { label: 'contextualized', text: 'what is normalization' },
      { label: 'rewritten', text: 'duplicate text' },
    ]);
  });

  test('truncates any query over 400 characters', () => {
    const longQuery = 'x'.repeat(500);
    const result = normalizeQueryPlan(plan({ rewrittenQuery: longQuery }), 'what is normalization', LIMITS);
    const rewritten = result.find((q) => q.label === 'rewritten');
    expect(rewritten?.text.length).toBe(400);
  });

  test('caps subqueries at maxSubQueries', () => {
    const result = normalizeQueryPlan(
      plan({ subQueries: ['sub one', 'sub two', 'sub three', 'sub four'] }),
      'what is normalization',
      LIMITS,
    );
    const subQueryLabels = result.filter((q) => q.label.startsWith('sub_query_')).map((q) => q.label);
    expect(subQueryLabels).toEqual(['sub_query_1', 'sub_query_2', 'sub_query_3']);
  });

  test('caps the total query set at maxQueries', () => {
    const result = normalizeQueryPlan(
      plan({
        rewrittenQuery: 'rewritten query text',
        stepBackQuery: 'step back query text',
        subQueries: ['sub one text', 'sub two text', 'sub three text'],
      }),
      'what is normalization',
      LIMITS,
    );
    expect(result.length).toBe(6);
    expect(result.map((q) => q.label)).toEqual([
      'contextualized',
      'rewritten',
      'step_back',
      'sub_query_1',
      'sub_query_2',
      'sub_query_3',
    ]);
  });

  test('an empty maxQueries budget still keeps the contextualized query', () => {
    const result = normalizeQueryPlan(
      plan({ rewrittenQuery: 'rewritten query text' }),
      'what is normalization',
      { maxQueries: 1, maxSubQueries: 3 },
    );
    expect(result).toEqual([{ label: 'contextualized', text: 'what is normalization' }]);
  });
});

describe('fallbackPlan', () => {
  test('yields a single-query plan containing only the contextualized query', () => {
    const result = fallbackPlan('what is normalization');
    expect(result).toEqual([{ label: 'contextualized', text: 'what is normalization' }]);
  });

  test('garbage / unparseable planning input falls back to the raw question as the sole query', () => {
    const result = fallbackPlan('   some raw user question   ');
    expect(result).toEqual([{ label: 'contextualized', text: 'some raw user question' }]);
  });
});

describe('normalizeAssessment', () => {
  function assessment(overrides: Partial<EvidenceAssessment> = {}): EvidenceAssessment {
    return {
      verdict: 'partial',
      rationale: '',
      supportingSourceIds: [],
      conflictingSourceIds: [],
      missingInformation: [],
      ...overrides,
    };
  }

  test('drops supporting and conflicting ids absent from the evidence map', () => {
    const validSourceIds = new Set(['SOURCE_1', 'SOURCE_2']);
    const result = normalizeAssessment(
      assessment({
        supportingSourceIds: ['SOURCE_1', 'SOURCE_99'],
        conflictingSourceIds: ['SOURCE_2', 'SOURCE_100'],
      }),
      validSourceIds,
    );
    expect(result.supportingSourceIds).toEqual(['SOURCE_1']);
    expect(result.conflictingSourceIds).toEqual(['SOURCE_2']);
  });

  test('keeps all ids when every id is known', () => {
    const validSourceIds = new Set(['SOURCE_1', 'SOURCE_2']);
    const result = normalizeAssessment(
      assessment({ supportingSourceIds: ['SOURCE_1', 'SOURCE_2'], conflictingSourceIds: [] }),
      validSourceIds,
    );
    expect(result.supportingSourceIds).toEqual(['SOURCE_1', 'SOURCE_2']);
  });
});
