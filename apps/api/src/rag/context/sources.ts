import type { Source } from '@rag/shared';
import type { EvidenceMap } from './contextBuilder';

const EXCERPT_MAX_CHARS = 240;

/** First ~240 chars for the evidence card, cut at a word boundary (spec §16.1). */
function excerpt(text: string): string {
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
function displayTime(hhmmss: string): string {
  const [hours, minutes, seconds] = hhmmss.split(':');
  if (hours === undefined || minutes === undefined || seconds === undefined) return hhmmss;
  return Number(hours) === 0 ? `${minutes}:${seconds}` : `${Number(hours)}:${minutes}:${seconds}`;
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

    sources.push({
      id: entry.sourceId,
      chunkId: entry.chunkId,
      transcriptId: entry.transcriptId,
      moduleId: entry.moduleId,
      moduleName: entry.moduleName,
      classId: entry.classId,
      className: entry.className,
      startTime: displayTime(entry.startTime),
      endTime: displayTime(entry.endTime),
      startMs: entry.startMs,
      endMs: entry.endMs,
      excerpt: excerpt(entry.text),
    });
  }

  return sources;
}
