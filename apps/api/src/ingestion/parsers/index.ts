import { AppError } from '../../errors/AppError';
import { TranscriptParseError } from './errors';
import { parseSrt } from './srt.parser';
import type { NormalizedCue, TranscriptFormat } from './types';
import { parseVtt } from './vtt.parser';

export type { NormalizedCue, TranscriptFormat } from './types';
export { TranscriptParseError } from './errors';
export { parseSrt } from './srt.parser';
export { parseVtt } from './vtt.parser';

const EXTENSIONS: Record<string, TranscriptFormat> = { srt: 'srt', vtt: 'vtt' };

/** A numeric counter line followed by an SRT timing line, the SRT signature. */
const SRT_SIGNATURE = /^﻿?\s*\d+\s*\n\s*\d{1,2}:[0-5]\d:[0-5]\d[,.]\d{1,3}\s*-->/;

/**
 * The extension proposes and the content disposes. A `.srt` file holding VTT is
 * a mislabeled export, not a transient fault, so it fails permanently rather
 * than consuming Inngest's retry budget (spec §5.1).
 */
export function detectFormat(fileName: string, content: string): TranscriptFormat {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  const claimed = EXTENSIONS[extension];
  if (claimed === undefined) {
    throw new AppError(
      'UNSUPPORTED_FILE_TYPE',
      `Unsupported transcript file "${fileName}". Only .srt and .vtt are accepted.`,
      { details: { allowed: ['.srt', '.vtt'] } },
    );
  }

  const looksVtt = content.replace(/^﻿/, '').trimStart().startsWith('WEBVTT');
  const looksSrt = SRT_SIGNATURE.test(content.replace(/\r\n?/g, '\n'));

  if (claimed === 'vtt' && !looksVtt) {
    throw new TranscriptParseError(
      `"${fileName}" has a .vtt extension but its content has no WEBVTT header.`,
    );
  }
  if (claimed === 'srt' && (looksVtt || !looksSrt)) {
    throw new TranscriptParseError(
      `"${fileName}" has an .srt extension but its content is not SRT.`,
    );
  }

  return claimed;
}

export function parseTranscript(fileName: string, content: string): NormalizedCue[] {
  const format = detectFormat(fileName, content);
  const cues = format === 'vtt' ? parseVtt(content) : parseSrt(content);

  if (cues.length === 0) {
    throw new TranscriptParseError(`"${fileName}" parsed to no cues with any spoken text.`);
  }

  return cues;
}
