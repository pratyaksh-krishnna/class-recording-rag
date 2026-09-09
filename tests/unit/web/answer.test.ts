import { test, expect, describe } from 'bun:test';
import type { Source } from '../../../packages/shared/src/contracts';
import { parseAnswer } from '../../../apps/web/src/lib/answer';

function makeSource(id: string): Source {
  return {
    id,
    chunkId: `chunk-${id}`,
    transcriptId: 'transcript-1',
    moduleId: 'module-1',
    moduleName: 'Module 7 — Device Sensors',
    classId: 'class-1',
    className: '2. Understanding the Gyroscope',
    startTime: '12:31',
    endTime: '14:42',
    startMs: 751_000,
    endMs: 882_000,
    excerpt: 'So this sensor measures how quickly the device rotates…',
  };
}

describe('parseAnswer', () => {
  test('empty string yields no segments', () => {
    expect(parseAnswer('', [])).toEqual([]);
  });

  test('plain text with no markers becomes a text segment', () => {
    const segments = parseAnswer('It measures rotation rate.', []);
    expect(segments).toEqual([
      { kind: 'text', paragraphs: ['It measures rotation rate.'] },
    ]);
  });

  test('several markers in one paragraph resolve to citations', () => {
    const source1 = makeSource('SOURCE_1');
    const source2 = makeSource('SOURCE_2');
    const segments = parseAnswer(
      'First [SOURCE_1] and second [SOURCE_2] cite.',
      [source1, source2],
    );

    expect(segments).toEqual([
      { kind: 'text', paragraphs: ['First '] },
      { kind: 'citation', sourceId: 'SOURCE_1', source: source1 },
      { kind: 'text', paragraphs: [' and second '] },
      { kind: 'citation', sourceId: 'SOURCE_2', source: source2 },
      { kind: 'text', paragraphs: [' cite.'] },
    ]);
  });

  test('marker at the very start of the answer', () => {
    const source1 = makeSource('SOURCE_1');
    const segments = parseAnswer('[SOURCE_1] opens the answer.', [source1]);

    expect(segments[0]).toEqual({
      kind: 'citation',
      sourceId: 'SOURCE_1',
      source: source1,
    });
    expect(segments[1]).toEqual({
      kind: 'text',
      paragraphs: [' opens the answer.'],
    });
  });

  test('marker at the very end of the answer', () => {
    const source1 = makeSource('SOURCE_1');
    const segments = parseAnswer('Answer ends at [SOURCE_1]', [source1]);

    expect(segments.at(-1)).toEqual({
      kind: 'citation',
      sourceId: 'SOURCE_1',
      source: source1,
    });
  });

  test('unresolvable [SOURCE_99] falls through as plain text without throwing', () => {
    expect(() => parseAnswer('See [SOURCE_99] here.', [])).not.toThrow();
    const segments = parseAnswer('See [SOURCE_99] here.', []);
    expect(segments).toEqual([
      { kind: 'text', paragraphs: ['See [SOURCE_99] here.'] },
    ]);
  });

  test('General knowledge: block is split into a general segment', () => {
    const segments = parseAnswer(
      'The recordings do not cover this.\n\nGeneral knowledge:\nIt is a sensor.',
      [],
    );

    expect(segments).toEqual([
      { kind: 'text', paragraphs: ['The recordings do not cover this.'] },
      {
        kind: 'general',
        heading: 'General knowledge:',
        segments: [{ kind: 'text', paragraphs: ['It is a sensor.'] }],
      },
    ]);
  });

  test('multi-paragraph text splits on blank lines', () => {
    const segments = parseAnswer('First paragraph.\n\nSecond paragraph.', []);
    expect(segments).toEqual([
      {
        kind: 'text',
        paragraphs: ['First paragraph.', 'Second paragraph.'],
      },
    ]);
  });
});
