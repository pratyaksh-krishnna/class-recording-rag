import type { Source } from '@rag/shared';
import type { HydratedChunk } from '../../db/repositories/chunks.repo';
import { formatTimestamp } from './contextBuilder';
import type { EvidenceMap } from './contextBuilder';

const EXCERPT_MAX_CHARS = 240;

/** First ~240 chars for the evidence card, cut at a word boundary (spec §16.1). */
export function excerpt(text: string): string {
  if (text.length <= EXCERPT_MAX_CHARS) return text;
  const cut = text.slice(0, EXCERPT_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}

/**
 * The evidence map (and the rendered context block, spec §12.2) keep full
 * zero-padded 'HH:MM:SS' — that's what the model reads and what the map is
 * keyed by. But `Source.startTime`/`endTime` are documented display strings
 * (spec §16.1: '12:31'), so the API's copy drops a leading zero hour rather
 * than showing '00:12:31'. An hour past the first is kept, unpadded
 * ('1:02:31'), never dropped.
 */
export function displayTime(hhmmss: string): string {
  const [hours, minutes, seconds] = hhmmss.split(':');
  if (hours === undefined || minutes === undefined || seconds === undefined) return hhmmss;
  return Number(hours) === 0 ? `${minutes}:${seconds}` : `${Number(hours)}:${minutes}:${seconds}`;
}

interface SourceFields {
  chunkId: string;
  transcriptId: string;
  moduleId: string;
  moduleName: string;
  classId: string;
  className: string;
  startMs: number;
  endMs: number;
  text: string;
  /** Evidence-map HH:MM:SS; when omitted, derived from `startMs`/`endMs`. */
  startTimeHms?: string;
  endTimeHms?: string;
}

function buildSourceFields(sourceId: string, fields: SourceFields): Source {
  const startTimeHms = fields.startTimeHms ?? formatTimestamp(fields.startMs);
  const endTimeHms = fields.endTimeHms ?? formatTimestamp(fields.endMs);
  return {
    id: sourceId,
    chunkId: fields.chunkId,
    transcriptId: fields.transcriptId,
    moduleId: fields.moduleId,
    moduleName: fields.moduleName,
    classId: fields.classId,
    className: fields.className,
    startTime: displayTime(startTimeHms),
    endTime: displayTime(endTimeHms),
    startMs: fields.startMs,
    endMs: fields.endMs,
    excerpt: excerpt(fields.text),
    content: fields.text,
  };
}

/**
 * Builds a `Source` from a hydrated database row. Both the live chat path
 * and `GET /api/conversations/:id` must call this — if either path formats
 * timestamps or excerpts differently, a reloaded conversation would disagree
 * with the live turn (spec §12.3).
 */
export function buildSource(sourceId: string, chunk: HydratedChunk): Source {
  return buildSourceFields(sourceId, {
    chunkId: chunk.id,
    transcriptId: chunk.transcriptId,
    moduleId: chunk.moduleId,
    moduleName: chunk.moduleName,
    classId: chunk.classId,
    className: chunk.className,
    startMs: chunk.startMs,
    endMs: chunk.endMs,
    text: chunk.text,
  });
}

/**
 * Resolves validated `[SOURCE_N]` markers to the API's `Source` contract.
 * Every field is read out of the evidence map — built from database rows —
 * never from anything the model produced; an id absent from the map (a
 * fabricated marker that survived upstream validation) is skipped, not
 * guessed. Output order follows `sourceIds`, which the caller passes in
 * first-appearance order in the answer (spec §14.1).
 */
export function toSources(sourceIds: string[], evidence: EvidenceMap): Source[] {
  const sources: Source[] = [];

  for (const sourceId of sourceIds) {
    const entry = evidence.get(sourceId);
    if (entry === undefined) continue;

    sources.push(
      buildSourceFields(entry.sourceId, {
        chunkId: entry.chunkId,
        text: entry.text,
        startMs: entry.startMs,
        endMs: entry.endMs,
        startTimeHms: entry.startTime,
        endTimeHms: entry.endTime,
        transcriptId: entry.transcriptId,
        classId: entry.classId,
        className: entry.className,
        moduleId: entry.moduleId,
        moduleName: entry.moduleName,
      }),
    );
  }

  return sources;
}
