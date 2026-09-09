import { test, expect, describe } from 'bun:test';
import { buildContext } from '../../../apps/api/src/rag/context/contextBuilder';
import type { HydratedChunk } from '../../../apps/api/src/db/repositories/chunks.repo';
import type { Tokenizer } from '../../../apps/api/src/ingestion/tokenizer/tokenizer';

/**
 * One token per whitespace-delimited word. Deterministic and legible, which
 * lets these tests state exact budgets — mirrors the fake used elsewhere in
 * the rag suite (spec §18.1).
 */
const wordTokenizer: Tokenizer = {
  name: 'test-words',
  count: (text) => (text.trim() ? text.trim().split(/\s+/).length : 0),
};

function chunk(overrides: Partial<HydratedChunk> & { id: string }): HydratedChunk {
  return {
    text: 'some default chunk text',
    startMs: 0,
    endMs: 1000,
    transcriptId: 'transcript-00000000-aaaa',
    classId: 'class-00000000-bbbb',
    className: 'Default Class',
    moduleId: 'module-00000000-cccc',
    moduleName: 'Default Module',
    ...overrides,
  };
}

describe('buildContext', () => {
  test('empty input yields empty context', () => {
    const result = buildContext([], wordTokenizer, 1000);

    expect(result.contextText).toBe('');
    expect(result.includedChunkIds).toEqual([]);
    expect(result.evidence.size).toBe(0);
    expect(result.contextTokens).toBe(0);
  });

  test('preserves the input (RRF) order exactly and never reorders', () => {
    const chunks = [
      chunk({ id: 'c-third', text: 'third chunk text here' }),
      chunk({ id: 'c-first', text: 'first chunk text here' }),
      chunk({ id: 'c-second', text: 'second chunk text here' }),
    ];

    const result = buildContext(chunks, wordTokenizer, 10_000);

    expect(result.includedChunkIds).toEqual(['c-third', 'c-first', 'c-second']);
  });

  test('assigns SOURCE_N in rank (input) order', () => {
    const chunks = [chunk({ id: 'c-a' }), chunk({ id: 'c-b' }), chunk({ id: 'c-c' })];

    const result = buildContext(chunks, wordTokenizer, 10_000);

    expect([...result.evidence.keys()]).toEqual(['SOURCE_1', 'SOURCE_2', 'SOURCE_3']);
    expect(result.evidence.get('SOURCE_1')!.chunkId).toBe('c-a');
    expect(result.evidence.get('SOURCE_2')!.chunkId).toBe('c-b');
    expect(result.evidence.get('SOURCE_3')!.chunkId).toBe('c-c');
  });

  test('stops as soon as adding the next chunk would exceed the budget', () => {
    // Each chunk's text is 5 tokens; the header adds more on top of that, so
    // the exact budget is derived from what buildContext itself reports for
    // one chunk, then used to prove a second, equally-sized chunk is excluded.
    const chunks = [
      chunk({ id: 'c-1', text: 'one two three four five' }),
      chunk({ id: 'c-2', text: 'six seven eight nine ten' }),
    ];

    const oneChunkResult = buildContext([chunks[0]!], wordTokenizer, 10_000);
    const singleCost = oneChunkResult.contextTokens;

    const result = buildContext(chunks, wordTokenizer, singleCost);

    expect(result.includedChunkIds).toEqual(['c-1']);
    expect(result.contextTokens).toBe(singleCost);
  });

  test('a budget smaller than a single chunk still yields exactly one chunk', () => {
    const chunks = [chunk({ id: 'c-1', text: 'one two three four five' })];

    const result = buildContext(chunks, wordTokenizer, 1);

    expect(result.includedChunkIds).toEqual(['c-1']);
    expect(result.evidence.size).toBe(1);
  });

  test('header cost counts toward the budget: a chunk that fits on text tokens alone is excluded once its header is counted', () => {
    const first = chunk({ id: 'c-1', text: 'one two three four five' });
    const second = chunk({ id: 'c-2', text: 'six seven eight nine ten' });

    // Budget fits both chunks' text (5 + 5 = 10 tokens) but not their headers.
    const result = buildContext([first, second], wordTokenizer, 10);

    expect(result.includedChunkIds).toEqual(['c-1']);
  });

  test('the evidence map has one entry per included chunk with metadata matching the input rows', () => {
    const row = chunk({
      id: 'c-1',
      text: 'the sensor measures rotation speed',
      startMs: 751_000,
      endMs: 882_000,
      transcriptId: 'transcript-abc12345-xyz',
      classId: 'class-abc12345-xyz',
      className: '2. Understanding the Gyroscope',
      moduleId: 'module-abc12345-xyz',
      moduleName: 'Module 7 — Device Sensors',
    });

    const result = buildContext([row], wordTokenizer, 10_000);
    const entry = result.evidence.get('SOURCE_1');

    expect(entry).toEqual({
      sourceId: 'SOURCE_1',
      chunkId: 'c-1',
      transcriptId: 'transcript-abc12345-xyz',
      moduleId: 'module-abc12345-xyz',
      moduleName: 'Module 7 — Device Sensors',
      classId: 'class-abc12345-xyz',
      className: '2. Understanding the Gyroscope',
      startMs: 751_000,
      endMs: 882_000,
      startTime: '00:12:31',
      endTime: '00:14:42',
      text: 'the sensor measures rotation speed',
    });
  });

  test('timestamps format as HH:MM:SS, including hours past 1:00:00', () => {
    const row = chunk({ id: 'c-1', startMs: 3_661_000, endMs: 7_384_000 });

    const result = buildContext([row], wordTokenizer, 10_000);
    const entry = result.evidence.get('SOURCE_1')!;

    expect(entry.startTime).toBe('01:01:01');
    expect(entry.endTime).toBe('02:03:04');
  });

  test('the rendered block matches the spec §12.2 layout', () => {
    const row = chunk({
      id: 'c-1',
      text: 'So this sensor measures how quickly the device is rotating',
      startMs: 751_000,
      endMs: 882_000,
      transcriptId: '6b7ecafe-0000-0000-0000-000000000000',
      classId: '8a11bead-0000-0000-0000-000000000000',
      className: '2. Understanding the Gyroscope',
      moduleId: '4f2caaaa-0000-0000-0000-000000000000',
      moduleName: 'Module 7 — Device Sensors',
    });
    // Two throwaway chunks ahead of it so it lands at SOURCE_3.
    const filler1 = chunk({ id: 'c-filler-1' });
    const filler2 = chunk({ id: 'c-filler-2' });

    const result = buildContext([filler1, filler2, row], wordTokenizer, 10_000);

    const expectedBlock = [
      '[SOURCE_3]',
      'module: Module 7 — Device Sensors (id: 4f2caaaa)',
      'class: 2. Understanding the Gyroscope (id: 8a11bead)',
      'timestamp: 00:12:31 – 00:14:42',
      'transcript: 6b7ecafe',
      '---',
      'So this sensor measures how quickly the device is rotating',
    ].join('\n');

    expect(result.contextText).toContain(expectedBlock);
  });
});
