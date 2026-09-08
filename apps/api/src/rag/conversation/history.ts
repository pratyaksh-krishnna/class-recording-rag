import type { Tokenizer } from '../../ingestion/tokenizer/tokenizer';

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Strips a stale `[SOURCE_N]` marker so it cannot bleed into this turn's own
 * source numbering (spec §15). Collapses the whitespace the removal leaves
 * behind and pulls any orphaned punctuation back against the preceding word,
 * without otherwise rewriting the text.
 */
function stripSourceMarkers(content: string): string {
  return content
    .replace(/\s*\[SOURCE_\d+\]\s*/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Budgets conversation history for the contextualizer and answer generator
 * (spec §15). Walks backward from the newest message, keeping whole
 * user/assistant pairs — an assistant message is never returned without the
 * question it answered. The current, not-yet-answered turn (a trailing lone
 * user message) is its own unit rather than half of a pair.
 *
 * Units are atomic: the first one (from the newest end) that would overflow
 * the budget is dropped along with everything older, so the result is always
 * a contiguous, recent suffix — never a truncated message and never a gap.
 */
export function selectHistory(
  messages: HistoryMessage[],
  budgetTokens: number,
  tokenizer: Tokenizer,
): HistoryMessage[] {
  if (messages.length === 0) return [];

  // Strip stale markers up front so token counts, the budget check, and the
  // returned messages all agree on the exact same text.
  const processed: HistoryMessage[] = messages.map((message) =>
    message.role === 'assistant'
      ? { role: message.role, content: stripSourceMarkers(message.content) }
      : message,
  );

  // Group into atomic units: consecutive (user, assistant) pairs from the
  // oldest, plus a trailing singleton if the conversation ends mid-turn.
  const units: HistoryMessage[][] = [];
  const pairCount = Math.floor(processed.length / 2);
  for (let p = 0; p < pairCount; p += 1) {
    const first = processed[2 * p];
    const second = processed[2 * p + 1];
    if (first === undefined || second === undefined) continue;
    units.push([first, second]);
  }
  if (processed.length % 2 === 1) {
    const last = processed[processed.length - 1];
    if (last !== undefined) units.push([last]);
  }

  const kept: HistoryMessage[][] = [];
  let used = 0;
  for (let u = units.length - 1; u >= 0; u -= 1) {
    const unit = units[u];
    if (unit === undefined) continue;
    const unitTokens = unit.reduce((sum, m) => sum + tokenizer.count(m.content), 0);
    if (used + unitTokens > budgetTokens) break;
    used += unitTokens;
    kept.unshift(unit);
  }

  return kept.flat();
}
