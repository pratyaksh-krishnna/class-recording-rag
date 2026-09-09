import type { HydratedChunk } from '../../db/repositories/chunks.repo';
import type { Tokenizer } from '../../ingestion/tokenizer/tokenizer';

export interface EvidenceEntry {
  sourceId: string; // 'SOURCE_3'
  chunkId: string;
  transcriptId: string;
  moduleId: string;
  moduleName: string;
  classId: string;
  className: string;
  startMs: number;
  endMs: number;
  startTime: string; // 'HH:MM:SS'
  endTime: string; // 'HH:MM:SS'
  text: string;
}

/**
 * 'SOURCE_3' → its citation metadata. Built entirely from the hydrated
 * database rows (spec §12.3): the model only ever sees the rendered text and
 * a `[SOURCE_N]` marker, so it has no path by which it could contribute a
 * timestamp, module name, class name, or chunk id. Every value a client
 * later sees for a citation is read back out of this map.
 */
export type EvidenceMap = Map<string, EvidenceEntry>;

export interface BuiltContext {
  contextText: string;
  evidence: EvidenceMap;
  includedChunkIds: string[];
  contextTokens: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** ms since chunk/class start → 'HH:MM:SS', per the rendered block (spec §12.2). */
function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

/** First 8 characters only — full uuids would dominate the rendered block (spec §12.2). */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Everything the model pays tokens for besides the passage itself: the
 * source marker, the metadata lines, and the '---' divider. Kept separate
 * from the passage so its cost can be counted on its own (spec §12.2).
 */
function renderHeader(
  sourceId: string,
  moduleName: string,
  moduleId: string,
  className: string,
  classId: string,
  startTime: string,
  endTime: string,
  transcriptId: string,
): string {
  return [
    `[${sourceId}]`,
    `module: ${moduleName} (id: ${shortId(moduleId)})`,
    `class: ${className} (id: ${shortId(classId)})`,
    `timestamp: ${startTime} – ${endTime}`,
    `transcript: ${shortId(transcriptId)}`,
    '---',
  ].join('\n');
}

/**
 * Orders, budgets, formats, and attaches metadata — nothing else (spec
 * §12.2). `chunks` is already in RRF order; this function must never reorder
 * or drop a chunk for any reason but the budget.
 */
export function buildContext(
  chunks: HydratedChunk[],
  tokenizer: Tokenizer,
  budgetTokens: number,
): BuiltContext {
  const evidence: EvidenceMap = new Map();
  const includedChunkIds: string[] = [];
  const blocks: string[] = [];
  let contextTokens = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === undefined) continue;

    const sourceId = `SOURCE_${index + 1}`;
    const startTime = formatTimestamp(chunk.startMs);
    const endTime = formatTimestamp(chunk.endMs);
    const header = renderHeader(
      sourceId,
      chunk.moduleName,
      chunk.moduleId,
      chunk.className,
      chunk.classId,
      startTime,
      endTime,
      chunk.transcriptId,
    );
    const cost = tokenizer.count(header) + tokenizer.count(chunk.text);

    // The first chunk is always included even if it alone exceeds the
    // budget — an empty context is useless (spec §12.2).
    if (includedChunkIds.length > 0 && contextTokens + cost > budgetTokens) break;

    contextTokens += cost;
    includedChunkIds.push(chunk.id);
    blocks.push(`${header}\n${chunk.text}`);
    evidence.set(sourceId, {
      sourceId,
      chunkId: chunk.id,
      transcriptId: chunk.transcriptId,
      moduleId: chunk.moduleId,
      moduleName: chunk.moduleName,
      classId: chunk.classId,
      className: chunk.className,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      startTime,
      endTime,
      text: chunk.text,
    });
  }

  return {
    contextText: blocks.join('\n\n'),
    evidence,
    includedChunkIds,
    contextTokens,
  };
}
