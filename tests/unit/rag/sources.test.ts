import { test, expect, describe } from 'bun:test';
import { toSources } from '../../../apps/api/src/rag/context/sources';
import type { EvidenceEntry, EvidenceMap } from '../../../apps/api/src/rag/context/contextBuilder';

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
    text: 'default text',
    ...overrides,
  };
}

function mapOf(...entries: EvidenceEntry[]): EvidenceMap {
  return new Map(entries.map((e) => [e.sourceId, e]));
}

describe('toSources', () => {
  test('maps ids to the right metadata, reading every field from the evidence map', () => {
    const evidence = mapOf(
      entry({
        sourceId: 'SOURCE_1',
        chunkId: 'c-1',
        transcriptId: 't-1',
        moduleId: 'm-1',
        moduleName: 'Module One',
        classId: 'cl-1',
        className: 'Class One',
        startMs: 100,
        endMs: 200,
        startTime: '00:00:01',
        endTime: '00:00:02',
        text: 'short text',
      }),
    );

    const [source] = toSources(['SOURCE_1'], evidence);

    expect(source).toEqual({
      id: 'SOURCE_1',
      chunkId: 'c-1',
      transcriptId: 't-1',
      moduleId: 'm-1',
      moduleName: 'Module One',
      classId: 'cl-1',
      className: 'Class One',
      startTime: '00:00:01',
      endTime: '00:00:02',
      startMs: 100,
      endMs: 200,
      excerpt: 'short text',
    });
  });

  test('an id absent from the evidence map is skipped, not guessed', () => {
    const evidence = mapOf(entry({ sourceId: 'SOURCE_1' }));

    const sources = toSources(['SOURCE_1', 'SOURCE_99'], evidence);

    expect(sources).toHaveLength(1);
    expect(sources[0]!.id).toBe('SOURCE_1');
  });

  test('excerpt is truncated at ~240 chars on a word boundary', () => {
    const longWord = 'a'.repeat(10);
    const words = new Array(30).fill(longWord); // 30 * 11 = 330 chars with spaces
    const longText = words.join(' ');
    const evidence = mapOf(entry({ sourceId: 'SOURCE_1', text: longText }));

    const [source] = toSources(['SOURCE_1'], evidence);

    expect(source!.excerpt.length).toBeLessThanOrEqual(240);
    // Cut at a word boundary: the excerpt is a prefix of the original text
    // and does not end mid-word (it must exactly equal the original text
    // truncated back to the preceding space).
    expect(longText.startsWith(source!.excerpt)).toBe(true);
    const cutPoint = source!.excerpt.length;
    expect(longText[cutPoint] === ' ' || cutPoint === longText.length).toBe(true);
  });

  test('a short text is returned whole, unmodified', () => {
    const evidence = mapOf(entry({ sourceId: 'SOURCE_1', text: 'a short excerpt' }));

    const [source] = toSources(['SOURCE_1'], evidence);

    expect(source!.excerpt).toBe('a short excerpt');
  });

  test('output order follows the given sourceIds array, not map insertion order', () => {
    const evidence = mapOf(
      entry({ sourceId: 'SOURCE_1', chunkId: 'c-1' }),
      entry({ sourceId: 'SOURCE_2', chunkId: 'c-2' }),
      entry({ sourceId: 'SOURCE_3', chunkId: 'c-3' }),
    );

    const sources = toSources(['SOURCE_3', 'SOURCE_1', 'SOURCE_2'], evidence);

    expect(sources.map((s) => s.id)).toEqual(['SOURCE_3', 'SOURCE_1', 'SOURCE_2']);
  });
});
