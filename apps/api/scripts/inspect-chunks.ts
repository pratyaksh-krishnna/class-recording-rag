import { loadEnv } from '../src/config/env.schema';
import { buildRagConfig } from '../src/config/rag';
import {
  parseTranscript,
  createRuleBasedSegmenter,
  reconstructSentences,
  createTokenizer,
  chunkSentences,
  type PreparedChunk,
} from '../src/ingestion';

/**
 * Manual inspection tool: prints what the chunker actually produces for one
 * transcript so a human can eyeball segment boundaries and token counts. No
 * database or OpenAI calls happen here, so the env vars below are placeholders
 * that only satisfy `loadEnv`'s required-field check.
 */

const path = process.argv[2];
if (path === undefined) {
  console.error('Usage: bun run apps/api/scripts/inspect-chunks.ts <path-to-.srt-or-.vtt>');
  process.exit(1);
}

const content = await Bun.file(path).text();
const contentHash = new Bun.CryptoHasher('sha256').update(content).digest('hex');

const env = loadEnv({
  ...process.env,
  DATABASE_URL: 'postgres://inspect',
  OPENAI_API_KEY: 'inspect',
});
const ragConfig = buildRagConfig(env);

const fileName = path.split('/').pop() ?? path;
const cues = parseTranscript(fileName, content);
const segmenter = createRuleBasedSegmenter();
const sentences = reconstructSentences(cues, segmenter);
const tokenizer = createTokenizer(ragConfig.chunking.tokenizerEncoding);

const { chunks, stats } = chunkSentences(
  sentences,
  {
    cohortSlug: 'inspect-cohort',
    moduleSlug: 'inspect-module',
    classSlug: 'inspect-class',
    contentHash,
    embeddingModel: ragConfig.embedding.model,
  },
  ragConfig.chunking,
  tokenizer,
);

/** mm:ss, truncating rather than rounding so spans never overstate duration. */
function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function preview(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed;
}

console.log(`file: ${fileName}`);
console.log(`cues: ${cues.length}`);
console.log(`sentences: ${stats.sentenceCount}`);
console.log(`chunks: ${chunks.length}`);
console.log(`oversizedSentences: ${stats.oversizedSentences}`);
console.log(`gapBoundariesUsed: ${stats.gapBoundariesUsed}`);
console.log('');

const idxWidth = String(chunks.length).length;
for (const chunk of chunks) {
  const idx = String(chunk.chunkIndex).padStart(idxWidth, ' ');
  const tokens = String(chunk.tokenCount).padStart(4, ' ');
  const sents = String(chunk.sentenceCount).padStart(3, ' ');
  const overlap = String(chunk.overlapSentenceCount).padStart(2, ' ');
  const span = `${formatMs(chunk.startMs)}-${formatMs(chunk.endMs)}`;
  console.log(
    `[${idx}] tokens=${tokens} sentences=${sents} overlap=${overlap} ${span}  ${preview(chunk.text, 60)}`,
  );
}

console.log('');

if (chunks.length === 0) {
  console.log('no chunks produced');
} else {
  const tokenCounts = chunks.map((c: PreparedChunk) => c.tokenCount);
  const min = Math.min(...tokenCounts);
  const max = Math.max(...tokenCounts);
  const mean = tokenCounts.reduce((sum, n) => sum + n, 0) / tokenCounts.length;
  const { minTokens, maxTokens } = ragConfig.chunking;
  const inWindow = tokenCounts.filter((n) => n >= minTokens && n <= maxTokens).length;

  console.log(`tokenCount: min=${min} max=${max} mean=${mean.toFixed(1)}`);
  console.log(
    `chunks within configured window [${minTokens}, ${maxTokens}]: ${inWindow}/${chunks.length}`,
  );
}
