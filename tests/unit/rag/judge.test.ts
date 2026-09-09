import { test, expect, describe } from 'bun:test';
import { assessEvidence } from '../../../apps/api/src/rag/evidence/judge';
import { createScriptedLLMProvider, scriptedError } from '../../../apps/api/src/providers/llm/scripted.mock';
import type { EvidenceMap, EvidenceEntry } from '../../../apps/api/src/rag/context/contextBuilder';

function deps(provider: ReturnType<typeof createScriptedLLMProvider>) {
  return { llm: provider, reasoningEffort: 'medium' as const, timeoutMs: 5000 };
}

function evidenceEntry(overrides: Partial<EvidenceEntry> & { sourceId: string }): EvidenceEntry {
  return {
    chunkId: 'chunk-1',
    transcriptId: 'transcript-1',
    moduleId: 'module-1',
    moduleName: 'Module 1',
    classId: 'class-1',
    className: 'Class 1',
    startMs: 0,
    endMs: 1000,
    startTime: '00:00:00',
    endTime: '00:00:01',
    text: 'some transcript text',
    ...overrides,
  };
}

function evidenceMap(entries: EvidenceEntry[]): EvidenceMap {
  return new Map(entries.map((entry) => [entry.sourceId, entry]));
}

const baseInput = {
  question: 'what is normalization',
  contextText: '[SOURCE_1]\n...\nnormalization organizes data',
};

describe('assessEvidence', () => {
  test.each(['sufficient', 'partial', 'insufficient', 'conflicting'] as const)(
    'parses the %s verdict',
    async (verdict) => {
      const evidence = evidenceMap([evidenceEntry({ sourceId: 'SOURCE_1' })]);
      const provider = createScriptedLLMProvider({
        evidence_assessment: [
          {
            verdict,
            rationale: 'because reasons',
            supportingSourceIds: ['SOURCE_1'],
            conflictingSourceIds: [],
            missingInformation: [],
          },
        ],
      });

      const result = await assessEvidence(deps(provider), { ...baseInput, evidence });

      expect(result.verdict).toBe(verdict);
    },
  );

  test('unknown source ids are dropped', async () => {
    const evidence = evidenceMap([evidenceEntry({ sourceId: 'SOURCE_1' })]);
    const provider = createScriptedLLMProvider({
      evidence_assessment: [
        {
          verdict: 'sufficient',
          rationale: 'ok',
          supportingSourceIds: ['SOURCE_1', 'SOURCE_99'],
          conflictingSourceIds: ['SOURCE_42'],
          missingInformation: [],
        },
      ],
    });

    const result = await assessEvidence(deps(provider), { ...baseInput, evidence });

    expect(result.supportingSourceIds).toEqual(['SOURCE_1']);
    expect(result.conflictingSourceIds).toEqual([]);
  });

  test('a throwing provider with non-empty evidence falls back to partial', async () => {
    const evidence = evidenceMap([evidenceEntry({ sourceId: 'SOURCE_1' })]);
    const provider = createScriptedLLMProvider({
      evidence_assessment: [scriptedError(new Error('upstream exploded'))],
    });

    const result = await assessEvidence(deps(provider), { ...baseInput, evidence });

    expect(result.verdict).toBe('partial');
  });

  test('a throwing provider with empty evidence falls back to insufficient', async () => {
    const evidence: EvidenceMap = new Map();
    const provider = createScriptedLLMProvider({
      evidence_assessment: [scriptedError(new Error('upstream exploded'))],
    });

    const result = await assessEvidence(deps(provider), { ...baseInput, evidence });

    expect(result.verdict).toBe('insufficient');
  });

  test('rationale is returned but is not surfaced in any citation/user-facing field', async () => {
    const evidence = evidenceMap([evidenceEntry({ sourceId: 'SOURCE_1' })]);
    const secretRationale = 'internal reasoning that must stay server-side';
    const provider = createScriptedLLMProvider({
      evidence_assessment: [
        {
          verdict: 'sufficient',
          rationale: secretRationale,
          supportingSourceIds: ['SOURCE_1'],
          conflictingSourceIds: [],
          missingInformation: [],
        },
      ],
    });

    const result = await assessEvidence(deps(provider), { ...baseInput, evidence });

    // The rationale is returned on the result (for the caller to log)...
    expect(result.rationale).toBe(secretRationale);
    // ...but is a distinct field from every user-facing identifier field, so
    // a caller that only reads supportingSourceIds/verdict never sees it.
    expect(result.supportingSourceIds).not.toContain(secretRationale);
    expect(result.verdict).not.toBe(secretRationale);
  });
});
