import { test, expect, describe } from 'bun:test';
import { generateAnswer } from '../../../apps/api/src/rag/generation/answerGenerator';
import { groundingPromptFor } from '../../../apps/api/src/rag/generation/prompts';
import { createScriptedLLMProvider, scriptedError } from '../../../apps/api/src/providers/llm/scripted.mock';
import type { EvidenceEntry, EvidenceMap } from '../../../apps/api/src/rag/context/contextBuilder';
import type { EvidenceAssessment, Answer } from '../../../apps/api/src/rag/schemas';
import { isAppError } from '../../../apps/api/src/errors/AppError';
import type { GroundingStatus } from '../../../packages/shared/src/grounding';

function entry(overrides: Partial<EvidenceEntry> & { sourceId: string }): EvidenceEntry {
  return {
    chunkId: `chunk-for-${overrides.sourceId}`,
    transcriptId: 'transcript-1',
    moduleId: 'module-1',
    moduleName: 'Module 1',
    classId: 'class-1',
    className: 'Class 1',
    startMs: 0,
    endMs: 1000,
    startTime: '00:00:00',
    endTime: '00:00:01',
    text: 'default evidence text',
    ...overrides,
  };
}

function mapOf(...entries: EvidenceEntry[]): EvidenceMap {
  return new Map(entries.map((e) => [e.sourceId, e]));
}

function baseInput(overrides: Partial<Parameters<typeof generateAnswer>[1]> = {}) {
  return {
    question: 'What is normalization?',
    contextText: '[SOURCE_1]\n...\n\n[SOURCE_2]\n...',
    evidence: mapOf(
      entry({ sourceId: 'SOURCE_1', chunkId: 'chunk-1' }),
      entry({ sourceId: 'SOURCE_2', chunkId: 'chunk-2' }),
    ),
    verdict: 'sufficient' as EvidenceAssessment['verdict'],
    history: [],
    allowGeneralKnowledgeFallback: true,
    ...overrides,
  };
}

function deps(provider: ReturnType<typeof createScriptedLLMProvider>) {
  return { llm: provider, reasoningEffort: 'medium' as const, timeoutMs: 5000 };
}

function answer(overrides: Partial<Answer>): Answer {
  return {
    answer: 'Default answer.',
    citedSourceIds: [],
    usedGeneralKnowledge: false,
    ...overrides,
  };
}

describe('generateAnswer', () => {
  test('valid markers map correctly to sources and citedSourceIds', async () => {
    const provider = createScriptedLLMProvider({
      answer: [
        answer({ answer: 'Normalization reduces redundancy [SOURCE_1] and improves integrity [SOURCE_2].' }),
      ],
    });

    const result = await generateAnswer(deps(provider), baseInput());

    expect(result.citedSourceIds).toEqual(['SOURCE_1', 'SOURCE_2']);
    expect(result.sources.map((s) => s.id)).toEqual(['SOURCE_1', 'SOURCE_2']);
    expect(result.groundingStatus).toBe('course_grounded');
    expect(result.regenerated).toBe(false);
    expect(result.fabricatedIds).toEqual([]);
    expect(provider.calls).toHaveLength(1);
  });

  test('a fabricated [SOURCE_9] triggers exactly one regeneration', async () => {
    const provider = createScriptedLLMProvider({
      answer: [
        answer({ answer: 'Claim from nowhere [SOURCE_9], real claim [SOURCE_1].' }),
        answer({ answer: 'Corrected claim, now grounded [SOURCE_1].' }),
      ],
    });

    const result = await generateAnswer(deps(provider), baseInput());

    expect(provider.calls).toHaveLength(2);
    expect(result.regenerated).toBe(true);
    expect(result.fabricatedIds).toEqual([]); // corrected on the retry, nothing to record
    expect(result.citedSourceIds).toEqual(['SOURCE_1']);
    expect(result.groundingStatus).toBe('course_grounded');

    // The corrective prompt names the valid ids for the model.
    const corrective = provider.calls[1]!;
    expect(corrective.user).toContain('SOURCE_9');
    expect(corrective.user).toContain('SOURCE_1');
  });

  test('still invalid after the one regeneration: marker stripped, fabricatedIds recorded, verdict-derived status stands when a valid citation survives', async () => {
    const provider = createScriptedLLMProvider({
      answer: [
        answer({ answer: 'First bad claim [SOURCE_9].' }),
        answer({ answer: 'Still fabricated [SOURCE_9], but this part is real [SOURCE_1].' }),
      ],
    });

    const result = await generateAnswer(deps(provider), baseInput());

    expect(provider.calls).toHaveLength(2);
    expect(result.regenerated).toBe(true);
    expect(result.fabricatedIds).toEqual(['SOURCE_9']);
    expect(result.answer).not.toContain('SOURCE_9');
    expect(result.answer).toContain('[SOURCE_1]');
    expect(result.citedSourceIds).toEqual(['SOURCE_1']);
    // sufficient verdict, one valid citation survives -> status stands
    expect(result.groundingStatus).toBe('course_grounded');
  });

  test('still invalid after regeneration and nothing survives: downgraded to general_knowledge', async () => {
    const provider = createScriptedLLMProvider({
      answer: [
        answer({ answer: 'Bad claim [SOURCE_9].' }),
        answer({ answer: 'Still entirely fabricated [SOURCE_9].' }),
      ],
    });

    const result = await generateAnswer(deps(provider), baseInput({ verdict: 'conflicting' }));

    expect(result.fabricatedIds).toEqual(['SOURCE_9']);
    expect(result.citedSourceIds).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.answer).not.toContain('SOURCE_9');
    expect(result.groundingStatus).toBe('general_knowledge');
  });

  test('sufficient verdict with zero citations downgrades to general_knowledge', async () => {
    const provider = createScriptedLLMProvider({
      answer: [answer({ answer: 'A confident answer with no citations at all.' })],
    });

    const result = await generateAnswer(deps(provider), baseInput({ verdict: 'sufficient' }));

    expect(provider.calls).toHaveLength(1); // no invalid markers -> no regeneration
    expect(result.regenerated).toBe(false);
    expect(result.citedSourceIds).toEqual([]);
    expect(result.groundingStatus).toBe('general_knowledge');
  });

  test('a non-sufficient verdict with zero citations (and no fabrication) is left alone', async () => {
    const provider = createScriptedLLMProvider({
      answer: [answer({ answer: 'Nothing to cite here.' })],
    });

    const result = await generateAnswer(deps(provider), baseInput({ verdict: 'partial' }));

    expect(result.citedSourceIds).toEqual([]);
    expect(result.groundingStatus).toBe('partially_grounded');
  });

  const verdictTable: [EvidenceAssessment['verdict'], GroundingStatus][] = [
    ['sufficient', 'course_grounded'],
    ['partial', 'partially_grounded'],
    ['insufficient', 'general_knowledge'],
    ['conflicting', 'conflicting'],
  ];

  for (const [verdict, expectedStatus] of verdictTable) {
    test(`verdict "${verdict}" maps to status "${expectedStatus}" and uses its own prompt`, async () => {
      const provider = createScriptedLLMProvider({
        answer: [answer({ answer: `Grounded claim [SOURCE_1].` })],
      });

      const result = await generateAnswer(deps(provider), baseInput({ verdict }));

      expect(result.groundingStatus).toBe(expectedStatus);
      expect(provider.calls[0]!.system).toBe(groundingPromptFor(verdict));
    });
  }

  test('sources are built only from validated markers, in first-appearance order in the answer', async () => {
    const evidence = mapOf(
      entry({ sourceId: 'SOURCE_1', chunkId: 'chunk-1' }),
      entry({ sourceId: 'SOURCE_2', chunkId: 'chunk-2' }),
      entry({ sourceId: 'SOURCE_3', chunkId: 'chunk-3' }),
    );
    const provider = createScriptedLLMProvider({
      answer: [
        answer({ answer: 'First mentions [SOURCE_3], then [SOURCE_1], not SOURCE_2 at all.' }),
      ],
    });

    const result = await generateAnswer(deps(provider), baseInput({ evidence }));

    expect(result.citedSourceIds).toEqual(['SOURCE_3', 'SOURCE_1']);
    expect(result.sources.map((s) => s.id)).toEqual(['SOURCE_3', 'SOURCE_1']);
    expect(result.sources.map((s) => s.chunkId)).toEqual(['chunk-3', 'chunk-1']);
  });

  test('a model citing an id absent from the evidence map can never inject metadata: every returned Source field comes from the map', async () => {
    const evidence = mapOf(
      entry({
        sourceId: 'SOURCE_1',
        chunkId: 'real-chunk-id',
        transcriptId: 'real-transcript-id',
        moduleId: 'real-module-id',
        moduleName: 'Real Module Name',
        classId: 'real-class-id',
        className: 'Real Class Name',
        startMs: 1000,
        endMs: 2000,
        startTime: '00:00:01',
        endTime: '00:00:02',
        text: 'the real evidence text',
      }),
    );
    // The model's prose references a source id (SOURCE_404) that does not
    // exist in the evidence map at all, alongside a valid one.
    const provider = createScriptedLLMProvider({
      answer: [
        answer({ answer: 'Fabricated context [SOURCE_404], real content [SOURCE_1].' }),
        answer({ answer: 'Corrected, only real content [SOURCE_1].' }),
      ],
    });

    const result = await generateAnswer(deps(provider), baseInput({ evidence }));

    expect(result.sources).toHaveLength(1);
    const [source] = result.sources;
    const mapEntry = evidence.get('SOURCE_1')!;
    expect(source!.chunkId).toBe(mapEntry.chunkId);
    expect(source!.transcriptId).toBe(mapEntry.transcriptId);
    expect(source!.moduleId).toBe(mapEntry.moduleId);
    expect(source!.moduleName).toBe(mapEntry.moduleName);
    expect(source!.classId).toBe(mapEntry.classId);
    expect(source!.className).toBe(mapEntry.className);
    expect(source!.startMs).toBe(mapEntry.startMs);
    expect(source!.endMs).toBe(mapEntry.endMs);
  });

  test('the corrective prompt is the only regeneration attempt: an invalid marker in both attempts still results in only two calls', async () => {
    const provider = createScriptedLLMProvider({
      answer: [
        answer({ answer: 'Bad [SOURCE_9].' }),
        answer({ answer: 'Still bad [SOURCE_9].' }),
      ],
    });

    await generateAnswer(deps(provider), baseInput());

    expect(provider.calls).toHaveLength(2);
  });

  test('the general-knowledge-fallback flag reaches the prompt', async () => {
    const provider = createScriptedLLMProvider({
      answer: [answer({ answer: 'Some answer [SOURCE_1].' })],
    });

    await generateAnswer(deps(provider), baseInput({ allowGeneralKnowledgeFallback: false }));

    expect(provider.calls[0]!.user).toContain('disabled');
  });

  test('generation failure survives one retry, then throws AppError LLM_FAILED', async () => {
    const provider = createScriptedLLMProvider({
      answer: [scriptedError(new Error('upstream down')), scriptedError(new Error('upstream still down'))],
    });

    let thrown: unknown;
    try {
      await generateAnswer(deps(provider), baseInput());
    } catch (error) {
      thrown = error;
    }

    expect(isAppError(thrown)).toBe(true);
    expect((thrown as { code?: string }).code).toBe('LLM_FAILED');
    expect(provider.calls).toHaveLength(2);
  });

  test('a single failure followed by success does not throw (the retry recovers)', async () => {
    const provider = createScriptedLLMProvider({
      answer: [scriptedError(new Error('blip')), answer({ answer: 'Recovered answer [SOURCE_1].' })],
    });

    const result = await generateAnswer(deps(provider), baseInput());

    expect(result.citedSourceIds).toEqual(['SOURCE_1']);
    expect(provider.calls).toHaveLength(2);
  });
});
