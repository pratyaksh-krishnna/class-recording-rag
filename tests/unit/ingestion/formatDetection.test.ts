import { test, expect, describe } from 'bun:test';
import { detectFormat, parseTranscript } from '../../../apps/api/src/ingestion/parsers';
import { TranscriptParseError } from '../../../apps/api/src/ingestion/parsers/errors';
import { AppError } from '../../../apps/api/src/errors/AppError';

const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello';
const srt = '1\n00:00:01,000 --> 00:00:02,000\nHello';

describe('detectFormat', () => {
  test('accepts an extension the content agrees with', () => {
    expect(detectFormat('lecture.vtt', vtt)).toBe('vtt');
    expect(detectFormat('lecture.srt', srt)).toBe('srt');
  });

  test('is case-insensitive about the extension', () => {
    expect(detectFormat('LECTURE.VTT', vtt)).toBe('vtt');
  });

  test('rejects an unsupported extension as an unsupported file type', () => {
    try {
      detectFormat('notes.txt', vtt);
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as AppError).code).toBe('UNSUPPORTED_FILE_TYPE');
    }
  });

  test('rejects VTT content behind an .srt extension', () => {
    expect(() => detectFormat('lecture.srt', vtt)).toThrow(TranscriptParseError);
  });

  test('rejects SRT content behind a .vtt extension', () => {
    expect(() => detectFormat('lecture.vtt', srt)).toThrow(/WEBVTT/);
  });

  test('treats a format mismatch as permanent, not retriable', () => {
    try {
      detectFormat('lecture.srt', vtt);
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as TranscriptParseError).retriable).toBe(false);
    }
  });
});

describe('parseTranscript', () => {
  test('dispatches to the parser the detected format names', () => {
    expect(parseTranscript('lecture.vtt', vtt)[0]?.text).toBe('Hello');
    expect(parseTranscript('lecture.srt', srt)[0]?.text).toBe('Hello');
  });

  test('rejects a transcript that yields no cues at all', () => {
    expect(() => parseTranscript('empty.vtt', 'WEBVTT\n')).toThrow(/no cues/);
  });
});
