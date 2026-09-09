/**
 * Pure retrieval and classification metrics for the eval harness (spec §19.2).
 * No I/O — every function here is deterministic so unit tests can hand-compute
 * expected values without mocking the pipeline.
 */

export interface ConfusionMatrixResult {
  labels: readonly string[];
  counts: number[][];
  accuracy: number;
}

/**
 * RRF and hybrid retrieval can surface the same class from multiple chunk hits;
 * deduplicating before rank-based metrics keeps Recall@K/MRR/nDCG from treating
 * one relevant class appearing twice as two separate hits (spec §19.2).
 */
function dedupePreservingOrder<T>(items: readonly T[]): T[] {
  const seen = new Set<T>();
  const deduped: T[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    deduped.push(item);
  }
  return deduped;
}

/**
 * Fraction of `relevant` items that appear in the first `k` of `retrieved`.
 * Returns 0 when `relevant` is empty — an empty ground-truth set is not a
 * free perfect score; it means the question has not been validated yet.
 */
export function recallAtK(retrieved: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 0;

  const relevantSet = new Set(relevant);
  const ranked = dedupePreservingOrder(retrieved).slice(0, k);
  let hits = 0;
  for (const item of ranked) {
    if (relevantSet.has(item)) hits += 1;
  }
  return hits / relevant.length;
}

/**
 * Reciprocal rank of the first retrieved item in `relevant`. Ranks start at 1;
 * returns 0 when no relevant item appears in `retrieved`.
 */
export function mrr(retrieved: string[], relevant: string[]): number {
  if (relevant.length === 0) return 0;

  const relevantSet = new Set(relevant);
  const ranked = dedupePreservingOrder(retrieved);
  for (let index = 0; index < ranked.length; index += 1) {
    const item = ranked[index];
    if (item !== undefined && relevantSet.has(item)) {
      return 1 / (index + 1);
    }
  }
  return 0;
}

function dcgAtK(retrieved: string[], relevant: string[], k: number): number {
  const relevantSet = new Set(relevant);
  const ranked = dedupePreservingOrder(retrieved).slice(0, k);
  let dcg = 0;
  for (let index = 0; index < ranked.length; index += 1) {
    const item = ranked[index];
    if (item === undefined || !relevantSet.has(item)) continue;
    const rank = index + 1;
    dcg += 1 / Math.log2(rank + 1);
  }
  return dcg;
}

/**
 * Normalized DCG with binary relevance and log2(rank + 1) discount (spec §19.2).
 * Ideal DCG assumes the first min(relevant.length, k) slots are all relevant.
 */
export function ndcgAtK(retrieved: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 0;

  const idealSlots = Math.min(relevant.length, k);
  let idealDcg = 0;
  for (let rank = 1; rank <= idealSlots; rank += 1) {
    idealDcg += 1 / Math.log2(rank + 1);
  }
  if (idealDcg === 0) return 0;

  return dcgAtK(retrieved, relevant, k) / idealDcg;
}

/**
 * Confusion matrix over fixed `labels`. `counts[expectedIndex][predictedIndex]`.
 * Pairs whose expected or predicted label is not in `labels` are skipped so a
 * novel grounding state from the model cannot crash aggregation.
 */
export function confusionMatrix(
  pairs: Array<{ expected: string; predicted: string }>,
  labels: readonly string[],
): ConfusionMatrixResult {
  const labelIndex = new Map<string, number>();
  labels.forEach((label, index) => {
    labelIndex.set(label, index);
  });

  const size = labels.length;
  const counts = Array.from({ length: size }, () => Array<number>(size).fill(0));

  let total = 0;
  let correct = 0;

  for (const pair of pairs) {
    const expectedIndex = labelIndex.get(pair.expected);
    const predictedIndex = labelIndex.get(pair.predicted);
    if (expectedIndex === undefined || predictedIndex === undefined) continue;

    const row = counts[expectedIndex];
    if (row === undefined) continue;
    row[predictedIndex] = (row[predictedIndex] ?? 0) + 1;
    total += 1;
    if (expectedIndex === predictedIndex) correct += 1;
  }

  return {
    labels,
    counts,
    accuracy: total === 0 ? 0 : correct / total,
  };
}
