import { test, expect, describe } from 'bun:test';
import { parseSrt } from '../../../apps/api/src/ingestion/parsers/srt.parser';
import { TranscriptParseError } from '../../../apps/api/src/ingestion/parsers/errors';

describe('parseSrt', () => {
  test('parses a well-formed file with HH:MM:SS,mmm timestamps', () => {
    const srt = [
      '1',
      '00:00:00,440 --> 00:00:03,320',
      'Hey everyone and welcome to one more new chapter.',
      '',
      '2',
      '00:01:02,100 --> 00:01:09,240',
      'Now that you know what API routes are,',
      "let's build some in an expo router project",
      '',
    ].join('\n');

    expect(parseSrt(srt)).toEqual([
      {
        index: 0,
        startMs: 440,
        endMs: 3320,
        text: 'Hey everyone and welcome to one more new chapter.',
        speaker: null,
      },
      {
        index: 1,
        startMs: 62_100,
        endMs: 69_240,
        text: "Now that you know what API routes are, let's build some in an expo router project",
        speaker: null,
      },
    ]);
  });

  test('accepts a final cue with no trailing newline', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nLast line with no newline';
    expect(parseSrt(srt)).toHaveLength(1);
    expect(parseSrt(srt)[0]?.text).toBe('Last line with no newline');
  });

  test('tolerates CRLF, a BOM, and runs of blank lines between cues', () => {
    const srt =
      '﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nFirst\r\n\r\n\r\n' +
      '2\r\n00:00:03,000 --> 00:00:04,000\r\nSecond\r\n';
    expect(parseSrt(srt).map((cue) => cue.text)).toEqual(['First', 'Second']);
  });

  test('renumbers cues by position, ignoring the numbers in the file', () => {
    const srt = '7\n00:00:01,000 --> 00:00:02,000\nA\n\n9\n00:00:03,000 --> 00:00:04,000\nB';
    expect(parseSrt(srt).map((cue) => cue.index)).toEqual([0, 1]);
  });

  test('drops cues whose text is empty after cleaning', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n\n\n2\n00:00:03,000 --> 00:00:04,000\nReal text';
    expect(parseSrt(srt).map((cue) => cue.text)).toEqual(['Real text']);
  });

  test('extracts a leading Speaker: prefix into the speaker field', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nPriya: cosine similarity is a dot product.';
    expect(parseSrt(srt)[0]).toMatchObject({
      speaker: 'Priya',
      text: 'cosine similarity is a dot product.',
    });
  });

  test('decodes HTML entities and strips inline tags', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n<b>vector</b> databases &amp; embeddings';
    expect(parseSrt(srt)[0]?.text).toBe('vector databases & embeddings');
  });

  test('rejects a block that has text but no timing line', () => {
    const srt = '1\n00:00:01,000 -> 00:00:02,000\nBroken arrow';
    expect(() => parseSrt(srt)).toThrow(TranscriptParseError);
  });

  test('rejects a cue that ends before it starts', () => {
    const srt = '1\n00:00:05,000 --> 00:00:02,000\nBackwards';
    expect(() => parseSrt(srt)).toThrow(/ends before it starts/);
  });

  test('marks parse failures permanent so ingestion does not retry them', () => {
    try {
      parseSrt('1\nnot a timing line\nText');
      throw new Error('expected a TranscriptParseError');
    } catch (error) {
      expect(error).toBeInstanceOf(TranscriptParseError);
      expect((error as TranscriptParseError).retriable).toBe(false);
    }
  });
});
