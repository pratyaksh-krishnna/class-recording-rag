import { test, expect, describe } from 'bun:test';
import { parseVtt } from '../../../apps/api/src/ingestion/parsers/vtt.parser';
import { TranscriptParseError } from '../../../apps/api/src/ingestion/parsers/errors';

const sample = [
  'WEBVTT',
  'Kind: captions',
  'Language: en',
  '',
  'NOTE',
  'This is a comment block and should be skipped.',
  '',
  '1',
  '00:00:01.000 --> 00:00:04.000',
  '<v Rahul>Hello everyone, welcome to class.</v>',
  '',
  '2',
  '00:00:04.500 --> 00:00:09.120 align:start position:0%',
  'Today we will talk about',
  'vector databases &amp; embeddings.',
  '',
  '02:10.250 --> 02:14.900',
  'Priya: So here is the thing: cosine similarity is just a dot product.',
  '',
  '00:05:00.000 --> 00:05:02.000',
  '<b>Bold</b> text with a <00:05:01.000>word timing.',
  '',
  '00:06:00.000 --> 00:06:01.000',
  '',
].join('\n');

describe('parseVtt', () => {
  test('skips the WEBVTT header block and its metadata lines', () => {
    expect(parseVtt(sample).map((cue) => cue.text)).not.toContain('Kind: captions');
    expect(parseVtt(sample)[0]?.text).toBe('Hello everyone, welcome to class.');
  });

  test('skips NOTE, STYLE, and REGION blocks', () => {
    for (const cue of parseVtt(sample)) {
      expect(cue.text).not.toContain('comment block');
    }
    const withStyle = 'WEBVTT\n\nSTYLE\n::cue { color: red }\n\n00:00:01.000 --> 00:00:02.000\nReal';
    expect(parseVtt(withStyle).map((cue) => cue.text)).toEqual(['Real']);
  });

  test('captures <v Name> as the speaker and strips the tag', () => {
    expect(parseVtt(sample)[0]).toMatchObject({
      speaker: 'Rahul',
      text: 'Hello everyone, welcome to class.',
      startMs: 1000,
      endMs: 4000,
    });
  });

  test('strips cue settings, joins wrapped lines, and decodes entities', () => {
    expect(parseVtt(sample)[1]).toMatchObject({
      startMs: 4500,
      endMs: 9120,
      text: 'Today we will talk about vector databases & embeddings.',
    });
  });

  test('supports the MM:SS.mmm short form', () => {
    expect(parseVtt(sample)[2]).toMatchObject({ startMs: 130_250, endMs: 134_900 });
  });

  test('extracts a Speaker: prefix without eating a mid-sentence colon', () => {
    expect(parseVtt(sample)[2]).toMatchObject({
      speaker: 'Priya',
      text: 'So here is the thing: cosine similarity is just a dot product.',
    });
  });

  test('strips presentation tags and word timings', () => {
    expect(parseVtt(sample)[3]?.text).toBe('Bold text with a word timing.');
  });

  test('ignores a cue with no text and renumbers what remains', () => {
    const cues = parseVtt(sample);
    expect(cues).toHaveLength(4);
    expect(cues.map((cue) => cue.index)).toEqual([0, 1, 2, 3]);
  });

  test('rejects content with no WEBVTT header', () => {
    expect(() => parseVtt('00:00:01.000 --> 00:00:02.000\nText')).toThrow(TranscriptParseError);
  });

  test('rejects a cue that ends before it starts', () => {
    expect(() => parseVtt('WEBVTT\n\n00:00:05.000 --> 00:00:02.000\nBackwards')).toThrow(
      /ends before it starts/,
    );
  });
});
