# Phase 2 — Deterministic Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a raw `.srt` / `.vtt` file into a deterministic list of timestamped, token-counted chunks with stable `chunk_key`s — with no I/O, no clock, and no randomness anywhere in the path.

**Architecture:** A pure pipeline of four stages, each a separate module with its own unit suite: `parse` (SRT/VTT → `NormalizedCue[]`), `reconstruct` (cues + segmenter → `ReconstructedSentence[]` carrying millisecond spans), `chunk` (sentences → `PreparedChunk[]` by the documented rule set R1–R8), and `chunkKey` (identity). A `Tokenizer` interface backed by `js-tiktoken` is injected, never estimated from character length. Nothing in this phase touches the database, the network, or Inngest — Phase 3 wires it up.

**Tech Stack:** Bun 1.3.14, TypeScript 5 (`strict`, `noUncheckedIndexedAccess`), `js-tiktoken` 1.0.21, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-08-transcript-rag-design.md` (§5 Ingestion, §6 Chunking, §18.1 Unit tests, §24 Phase 2)

## Global Constraints

- **Runtime is Bun.** `bun <file>`, `bun test`, `bun install`, `bun add`. Never `npm`, `node`, `ts-node`, `jest`, `vitest`.
- **`tsconfig.json` sets `strict: true` and `noUncheckedIndexedAccess: true`.** Every array and record lookup yields `T | undefined` and must be narrowed before use. This dominates the style of every loop in this phase.
- **Branch:** `feat/phase-2-chunking` (already checked out).
- **Everything in this phase is pure and synchronous.** No `Date.now()`, no `Math.random()`, no `Bun.file`, no `fetch`, no database. Identical input must always yield byte-identical output — that is what makes `ON CONFLICT (chunk_key) DO NOTHING` an idempotent ingestion in Phase 3.
- **Never log chunk text, question text, or answer text at `info` level** (spec §20). No module in this phase logs at all.
- **Token counts are always produced by the injected `Tokenizer`**, never by `text.length / 4` or any other estimate (spec §18.1 "Tokenizer: deterministic; never estimated from character length").
- Chunking defaults: target **500**, min **350**, max **650**, overlap ratio **0.125**, gap preferred **2000 ms**, version **v1**, encoding **o200k_base** (spec §22). All already validated in `apps/api/src/config/rag.ts` — read them from `RagConfig['chunking']`, never re-declare them.
- Tests live in `tests/unit/ingestion/**`. This phase adds no integration tests: it has no services to integrate with.
- A parse failure is a **permanent** error, never retried (spec §5.1). It is modelled as `TranscriptParseError extends AppError` with `retriable: false`.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/ingestion/tokenizer/tokenizer.ts` | `Tokenizer` interface + memoized `js-tiktoken` implementation |
| `apps/api/src/ingestion/parsers/types.ts` | `NormalizedCue`, `TranscriptFormat` |
| `apps/api/src/ingestion/parsers/errors.ts` | `TranscriptParseError` — permanent, non-retriable |
| `apps/api/src/ingestion/parsers/clean.ts` | Tag stripping (capturing `<v Name>`), entity decoding, `Speaker:` extraction, whitespace normalization, cue-block splitting |
| `apps/api/src/ingestion/parsers/srt.parser.ts` | `parseSrt(content): NormalizedCue[]` |
| `apps/api/src/ingestion/parsers/vtt.parser.ts` | `parseVtt(content): NormalizedCue[]` |
| `apps/api/src/ingestion/parsers/index.ts` | `detectFormat` (extension + content sniff) and `parseTranscript` dispatch |
| `apps/api/src/ingestion/sentences/abbreviations.ts` | The abbreviation set that suppresses false boundaries |
| `apps/api/src/ingestion/sentences/segmenter.ts` | `SentenceSegmenter` interface, `Sentence`, options + defaults |
| `apps/api/src/ingestion/sentences/ruleBased.segmenter.ts` | The rule-based segmenter (spec §5.3) |
| `apps/api/src/ingestion/sentences/reconstruct.ts` | Cues → sentences with `startMs` / `endMs` / `gapAfterMs` (spec §5.2) |
| `apps/api/src/ingestion/chunking/chunkKey.ts` | `buildChunkKey` — deterministic identity (spec §5.4) |
| `apps/api/src/ingestion/chunking/chunker.ts` | `chunkSentences` — the R1–R8 rule engine (spec §6) |
| `apps/api/src/ingestion/index.ts` | Barrel: the four stages Phase 3 imports |
| `apps/api/scripts/inspect-chunks.ts` | Hand-inspection of chunker output on a real class (the §24 done-criterion) |

Each stage is separately testable because each is a pure function whose inputs
are plain data. The dependency direction is strictly one way:
`parsers → sentences → chunking`, with `tokenizer` injected into chunking only.

---

## Task 1: Tokenizer

**Files:**
- Create: `apps/api/src/ingestion/tokenizer/tokenizer.ts`
- Test: `tests/unit/ingestion/tokenizer.test.ts`
- Modify: `package.json`, `apps/api/package.json` (commit the already-added `js-tiktoken` dependency)

**Interfaces:**
- Consumes: `ConfigError` from `apps/api/src/config/env.schema.ts`
- Produces: `interface Tokenizer { readonly name: string; count(text: string): number }` and `createTokenizer(encoding: string): Tokenizer`. The chunker (Task 8) takes a `Tokenizer` as its fourth parameter; `tokenizer.name` is stored on every chunk row as the `tokenizer` column.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ingestion/tokenizer.test.ts`:

```ts
import { test, expect, describe } from 'bun:test';
import { createTokenizer } from '../../../apps/api/src/ingestion/tokenizer/tokenizer';

describe('tokenizer', () => {
  test('counts real BPE tokens, not characters', () => {
    const tokenizer = createTokenizer('o200k_base');
    // 33 characters, far fewer tokens — a character-length estimate cannot pass this.
    const text = 'Hello everyone, welcome to class.';
    expect(text.length).toBe(33);
    expect(tokenizer.count(text)).toBe(7);
  });

  test('is deterministic across calls and instances', () => {
    const text = 'Cosine similarity is just a normalized dot product.';
    const a = createTokenizer('o200k_base');
    const b = createTokenizer('o200k_base');
    expect(a.count(text)).toBe(b.count(text));
    expect(a.count(text)).toBe(a.count(text));
  });

  test('counts the empty string as zero tokens', () => {
    expect(createTokenizer('o200k_base').count('')).toBe(0);
  });

  test('exposes the encoding name for persistence', () => {
    expect(createTokenizer('cl100k_base').name).toBe('cl100k_base');
  });

  test('rejects an unknown encoding as a configuration error', () => {
    expect(() => createTokenizer('not_an_encoding')).toThrow(/not_an_encoding/);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test tests/unit/ingestion/tokenizer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tokenizer**

Create `apps/api/src/ingestion/tokenizer/tokenizer.ts`:

```ts
import { getEncoding, type Tiktoken, type TiktokenEncoding } from 'js-tiktoken';
import { ConfigError } from '../../config/env.schema';

/**
 * Token counting is injected rather than imported so the chunker stays pure and
 * testable with a trivial fake. Counts must come from a real BPE encoder: a
 * character-length estimate drifts by 20%+ on transcript prose, which would put
 * chunks outside the 350–650 window the retrieval budget assumes (spec §6).
 */
export interface Tokenizer {
  /** The encoding name, persisted on every chunk row as `tokenizer`. */
  readonly name: string;
  count(text: string): number;
}

/**
 * Building an encoder parses a megabyte-scale rank table, so instances are
 * shared per encoding. They are immutable and stateless, which makes sharing
 * safe and keeps counts identical across callers.
 */
const encoders = new Map<string, Tiktoken>();

function encoderFor(encoding: string): Tiktoken {
  const cached = encoders.get(encoding);
  if (cached) return cached;

  let encoder: Tiktoken;
  try {
    encoder = getEncoding(encoding as TiktokenEncoding);
  } catch (cause) {
    throw new ConfigError(
      `Unknown tokenizer encoding "${encoding}". Set TOKENIZER_ENCODING to a ` +
        `js-tiktoken encoding such as o200k_base or cl100k_base.`,
      { cause },
    );
  }
  encoders.set(encoding, encoder);
  return encoder;
}

export function createTokenizer(encoding: string): Tokenizer {
  const encoder = encoderFor(encoding);
  return {
    name: encoding,
    count: (text) => (text.length === 0 ? 0 : encoder.encode(text).length),
  };
}
```

`ConfigError` currently declares no options parameter. Widen its constructor in
`apps/api/src/config/env.schema.ts` so a cause can be attached:

```ts
export class ConfigError extends Error {
  override readonly name = 'ConfigError';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test tests/unit/ingestion/tokenizer.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add package.json apps/api/package.json bun.lock apps/api/src/ingestion/tokenizer/tokenizer.ts apps/api/src/config/env.schema.ts tests/unit/ingestion/tokenizer.test.ts
git commit -m "feat(ingestion): real BPE token counting behind a Tokenizer interface"
```

---

## Task 2: Cue types, parse errors, cleaning, and the SRT parser

**Files:**
- Create: `apps/api/src/ingestion/parsers/types.ts`
- Create: `apps/api/src/ingestion/parsers/errors.ts`
- Create: `apps/api/src/ingestion/parsers/clean.ts`
- Create: `apps/api/src/ingestion/parsers/srt.parser.ts`
- Test: `tests/unit/ingestion/srt.parser.test.ts`

**Interfaces:**
- Consumes: `AppError` from `apps/api/src/errors/AppError.ts`
- Produces: `NormalizedCue { index: number; startMs: number; endMs: number; text: string; speaker: string | null }`, `type TranscriptFormat = 'srt' | 'vtt'`, `class TranscriptParseError extends AppError` (with `readonly retriable = false`), `cleanCueText(lines: string[]): { text: string; speaker: string | null }`, `splitBlocks(content: string): string[][]`, and `parseSrt(content: string): NormalizedCue[]`. Task 3's VTT parser reuses `cleanCueText` and `splitBlocks`; Task 4 dispatches to `parseSrt`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ingestion/srt.parser.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test tests/unit/ingestion/srt.parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement types, errors, cleaning, and the parser**

Create `apps/api/src/ingestion/parsers/types.ts`:

```ts
/** The single shape both parsers emit. Downstream code never knows the format. */
export interface NormalizedCue {
  /**
   * Position in the emitted list, zero-based — deliberately NOT the number
   * printed in the file, which real transcripts repeat, skip, and restart.
   */
  index: number;
  startMs: number;
  endMs: number;
  /** Cleaned: tags stripped, entities decoded, whitespace collapsed. */
  text: string;
  /** Captured for V2 playback attribution; unused by V1 retrieval. */
  speaker: string | null;
}

export type TranscriptFormat = 'srt' | 'vtt';
```

Create `apps/api/src/ingestion/parsers/errors.ts`:

```ts
import { AppError } from '../../errors/AppError';

/**
 * A malformed transcript is permanently malformed — the same bytes will fail
 * the same way forever. Inngest reads `retriable` to fail the step outright
 * instead of burning its retry budget (spec §5.1).
 */
export class TranscriptParseError extends AppError {
  readonly retriable = false;

  constructor(message: string, details?: unknown) {
    super('VALIDATION_ERROR', message, details !== undefined ? { details } : {});
  }
}
```

Create `apps/api/src/ingestion/parsers/clean.ts`:

```ts
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * A voice span carries the speaker: `<v Rahul>text</v>`. Every other angle
 * bracket construct in a caption file — `<b>`, `<i>`, `<c.yellow>`, and the
 * `<00:05:01.000>` word timings VTT uses for karaoke highlighting — is
 * presentation and is dropped.
 */
const VOICE_TAG = /<v\.?[^\s>]*\s+([^>]+)>/i;
const ANY_TAG = /<[^>]*>/g;

/**
 * A speaker prefix is at most three capitalized words before a colon. The
 * bound matters: without it, "So here is the thing: cosine similarity..."
 * would lose its first clause to a phantom speaker.
 */
const SPEAKER_PREFIX = /^([A-Z][\p{L}\p{N}.'’-]*(?:[ \t][A-Z][\p{L}\p{N}.'’-]*){0,2}):[ \t]+/u;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[lower] ?? match;
  });
}

export interface CleanedCue {
  text: string;
  speaker: string | null;
}

/**
 * Order is load-bearing. Tags are stripped before entities are decoded so a
 * literal `&lt;b&gt;` in the transcript survives as visible text instead of
 * being turned into markup and then deleted.
 */
export function cleanCueText(lines: string[]): CleanedCue {
  const raw = lines.join(' ');

  const voice = VOICE_TAG.exec(raw);
  let speaker = voice?.[1]?.trim() ?? null;

  let text = decodeEntities(raw.replace(ANY_TAG, ' '));
  text = text.replace(/\s+/g, ' ').trim();

  if (speaker === null) {
    const prefix = SPEAKER_PREFIX.exec(text);
    if (prefix?.[1]) {
      speaker = prefix[1];
      text = text.slice(prefix[0].length).trim();
    }
  }

  return { text, speaker: speaker === null || speaker.length === 0 ? null : speaker };
}

/**
 * Splits a caption file into blank-line-separated blocks of non-empty lines.
 * Handles CRLF, a leading BOM, and runs of blank lines, none of which are
 * unusual in files exported by transcription tools.
 */
export function splitBlocks(content: string): string[][] {
  const normalized = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of normalized.split('\n')) {
    if (line.trim().length === 0) {
      if (current.length > 0) blocks.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current);

  return blocks;
}
```

Create `apps/api/src/ingestion/parsers/srt.parser.ts`:

```ts
import { cleanCueText, splitBlocks } from './clean';
import { TranscriptParseError } from './errors';
import type { NormalizedCue } from './types';

/** `HH:MM:SS,mmm --> HH:MM:SS,mmm`. A dot in place of the comma is tolerated. */
const TIMING = /^(\d{1,2}):([0-5]\d):([0-5]\d)[,.](\d{1,3})\s*-->\s*(\d{1,2}):([0-5]\d):([0-5]\d)[,.](\d{1,3})/;

function toMs(h: string, m: string, s: string, ms: string): number {
  return (
    Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + Number(ms.padEnd(3, '0'))
  );
}

export function parseSrt(content: string): NormalizedCue[] {
  const cues: NormalizedCue[] = [];

  for (const block of splitBlocks(content)) {
    // The numeric counter is optional in practice; skip it when present.
    const first = block[0];
    if (first === undefined) continue;
    const body = TIMING.test(first) ? block : block.slice(1);

    const timingLine = body[0];
    if (timingLine === undefined || !TIMING.test(timingLine)) {
      throw new TranscriptParseError(
        `SRT cue ${cues.length + 1} has no valid "HH:MM:SS,mmm --> HH:MM:SS,mmm" timing line.`,
      );
    }

    const match = TIMING.exec(timingLine);
    // TIMING.test above guarantees a match; this narrows for the type checker.
    if (match === null) continue;
    const [, h1 = '', m1 = '', s1 = '', ms1 = '', h2 = '', m2 = '', s2 = '', ms2 = ''] = match;

    const startMs = toMs(h1, m1, s1, ms1);
    const endMs = toMs(h2, m2, s2, ms2);
    if (endMs < startMs) {
      throw new TranscriptParseError(
        `SRT cue ${cues.length + 1} ends before it starts (${startMs}ms → ${endMs}ms).`,
      );
    }

    const { text, speaker } = cleanCueText(body.slice(1));
    if (text.length === 0) continue;

    cues.push({ index: cues.length, startMs, endMs, text, speaker });
  }

  return cues;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test tests/unit/ingestion/srt.parser.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ingestion/parsers tests/unit/ingestion/srt.parser.test.ts
git commit -m "feat(ingestion): SRT parser with deterministic cue cleaning"
```

---

## Task 3: VTT parser

**Files:**
- Create: `apps/api/src/ingestion/parsers/vtt.parser.ts`
- Test: `tests/unit/ingestion/vtt.parser.test.ts`

**Interfaces:**
- Consumes: `cleanCueText`, `splitBlocks` (Task 2), `TranscriptParseError`, `NormalizedCue`
- Produces: `parseVtt(content: string): NormalizedCue[]`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ingestion/vtt.parser.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test tests/unit/ingestion/vtt.parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the VTT parser**

Create `apps/api/src/ingestion/parsers/vtt.parser.ts`:

```ts
import { cleanCueText, splitBlocks } from './clean';
import { TranscriptParseError } from './errors';
import type { NormalizedCue } from './types';

/** `[HH:]MM:SS.mmm --> [HH:]MM:SS.mmm` followed by optional cue settings. */
const TIMING =
  /^(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)[.,](\d{1,3})\s*-->\s*(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)[.,](\d{1,3})/;

/** Blocks that describe presentation or metadata rather than spoken content. */
const NON_CUE_BLOCK = /^(NOTE|STYLE|REGION)\b/;

function toMs(h: string | undefined, m: string, s: string, ms: string): number {
  return (
    Number(h ?? 0) * 3_600_000 +
    Number(m) * 60_000 +
    Number(s) * 1000 +
    Number(ms.padEnd(3, '0'))
  );
}

export function parseVtt(content: string): NormalizedCue[] {
  const blocks = splitBlocks(content);

  const header = blocks[0]?.[0];
  if (header === undefined || !header.startsWith('WEBVTT')) {
    throw new TranscriptParseError('VTT content does not begin with a WEBVTT header.');
  }

  const cues: NormalizedCue[] = [];

  // blocks[0] is the header block: WEBVTT plus its Kind:/Language: metadata.
  for (const block of blocks.slice(1)) {
    const first = block[0];
    if (first === undefined || NON_CUE_BLOCK.test(first)) continue;

    // The cue identifier line is optional; when present it precedes the timing.
    const body = TIMING.test(first) ? block : block.slice(1);
    const timingLine = body[0];
    if (timingLine === undefined || !TIMING.test(timingLine)) continue;

    const match = TIMING.exec(timingLine);
    if (match === null) continue;
    const [, h1, m1 = '', s1 = '', ms1 = '', h2, m2 = '', s2 = '', ms2 = ''] = match;

    const startMs = toMs(h1, m1, s1, ms1);
    const endMs = toMs(h2, m2, s2, ms2);
    if (endMs < startMs) {
      throw new TranscriptParseError(
        `VTT cue ${cues.length + 1} ends before it starts (${startMs}ms → ${endMs}ms).`,
      );
    }

    const { text, speaker } = cleanCueText(body.slice(1));
    if (text.length === 0) continue;

    cues.push({ index: cues.length, startMs, endMs, text, speaker });
  }

  return cues;
}
```

Note the asymmetry with SRT: a VTT block that is neither a comment nor a cue is
skipped rather than rejected, because the format legitimately carries block
kinds this parser does not model. SRT has no such blocks, so an untimed block
there is genuine corruption.

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test tests/unit/ingestion/vtt.parser.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ingestion/parsers/vtt.parser.ts tests/unit/ingestion/vtt.parser.test.ts
git commit -m "feat(ingestion): VTT parser with speaker capture and settings stripping"
```

---

## Task 4: Format detection and dispatch

**Files:**
- Create: `apps/api/src/ingestion/parsers/index.ts`
- Test: `tests/unit/ingestion/formatDetection.test.ts`

**Interfaces:**
- Consumes: `parseSrt` (Task 2), `parseVtt` (Task 3), `TranscriptParseError`, `TranscriptFormat`
- Produces: `detectFormat(fileName: string, content: string): TranscriptFormat` and `parseTranscript(fileName: string, content: string): NormalizedCue[]`. Phase 3's upload endpoint and seeder call `parseTranscript` and nothing else.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ingestion/formatDetection.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test tests/unit/ingestion/formatDetection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement detection and dispatch**

Create `apps/api/src/ingestion/parsers/index.ts`:

```ts
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
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test tests/unit/ingestion/formatDetection.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ingestion/parsers/index.ts tests/unit/ingestion/formatDetection.test.ts
git commit -m "feat(ingestion): format detection with content sniffing and permanent mismatch errors"
```

---

## Task 5: Sentence segmentation

**Files:**
- Create: `apps/api/src/ingestion/sentences/abbreviations.ts`
- Create: `apps/api/src/ingestion/sentences/segmenter.ts`
- Create: `apps/api/src/ingestion/sentences/ruleBased.segmenter.ts`
- Test: `tests/unit/ingestion/segmenter.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `interface Sentence { text: string; startChar: number; endChar: number }`, `interface SentenceSegmenter { segment(text: string): Sentence[] }`, `interface SegmenterOptions { minSentenceChars: number; maxSentenceChars: number }`, `DEFAULT_SEGMENTER_OPTIONS`, and `createRuleBasedSegmenter(options?: Partial<SegmenterOptions>): SentenceSegmenter`. Task 6 consumes `SentenceSegmenter`; the `[startChar, endChar)` range is what makes the cue→millisecond mapping possible.

The floor and ceiling are segmenter options rather than environment variables:
spec §22 lists no variables for them, and they are properties of the
segmentation algorithm rather than deployment knobs. They remain injectable so
tests can drive the ceiling without a 400-character fixture.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ingestion/segmenter.test.ts`:

```ts
import { test, expect, describe } from 'bun:test';
import { createRuleBasedSegmenter } from '../../../apps/api/src/ingestion/sentences/ruleBased.segmenter';

const segmenter = createRuleBasedSegmenter();
const texts = (input: string) => segmenter.segment(input).map((sentence) => sentence.text);

describe('rule-based sentence segmentation', () => {
  test('splits on terminal punctuation followed by a capital', () => {
    expect(texts('This is one. This is two! Is this three?')).toEqual([
      'This is one.',
      'This is two!',
      'Is this three?',
    ]);
  });

  test('reports character ranges that slice back to the sentence text', () => {
    const input = 'First sentence here. Second sentence here.';
    for (const sentence of segmenter.segment(input)) {
      expect(input.slice(sentence.startChar, sentence.endChar)).toBe(sentence.text);
    }
  });

  test('does not split after a known abbreviation', () => {
    expect(texts('We use vectors, e.g. embeddings, for search. That is the idea.')).toEqual([
      'We use vectors, e.g. embeddings, for search.',
      'That is the idea.',
    ]);
    expect(texts('Ask Dr. Rao about the syllabus first.')).toHaveLength(1);
  });

  test('does not split inside a decimal or a version number', () => {
    expect(texts('The threshold is 3.5 for this run.')).toHaveLength(1);
    expect(texts('We are on v4.2 of the API now.')).toHaveLength(1);
  });

  test('keeps a percentage in its sentence', () => {
    expect(texts('Recall went up 100%. That is the headline.')).toEqual([
      'Recall went up 100%.',
      'That is the headline.',
    ]);
  });

  test('does not split an ellipsis followed by a lowercase continuation', () => {
    expect(texts('So the vector... the vector is normalized first.')).toHaveLength(1);
  });

  test('does not split when the next character is lowercase', () => {
    expect(texts('We index the text. then we embed it.')).toHaveLength(1);
  });

  test('keeps a list of short clauses as one sentence', () => {
    expect(texts('x axis, y axis, z axis all move together.')).toHaveLength(1);
  });

  test('does not split on initials below the character floor', () => {
    expect(texts('A. B. C. are the three cases we care about.')).toHaveLength(1);
  });

  test('caps an unpunctuated run at a clause boundary instead of emitting one blob', () => {
    const short = createRuleBasedSegmenter({ maxSentenceChars: 40 });
    const input =
      'so we take the vector and we normalize it, then we compare it with cosine similarity, and that is all';
    const sentences = short.segment(input);
    expect(sentences.length).toBeGreaterThan(1);
    for (const sentence of sentences) {
      expect(sentence.text.length).toBeLessThanOrEqual(40);
    }
    expect(sentences.map((sentence) => sentence.text).join(' ')).toBe(input);
  });

  test('emits nothing for empty or whitespace-only input', () => {
    expect(segmenter.segment('')).toEqual([]);
    expect(segmenter.segment('   \n  ')).toEqual([]);
  });

  test('emits a final sentence that has no terminal punctuation', () => {
    expect(texts('This one ends. And this one just stops')).toEqual([
      'This one ends.',
      'And this one just stops',
    ]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test tests/unit/ingestion/segmenter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the abbreviation list and the segmenter**

Create `apps/api/src/ingestion/sentences/abbreviations.ts`:

```ts
/**
 * Tokens whose trailing period is part of the word, not a sentence end.
 * Stored lowercase with the period; lookups lowercase the candidate token.
 * Kept deliberately small — every entry is a boundary this segmenter will
 * never propose, so an over-long list silently welds sentences together.
 */
export const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'e.g.', 'i.e.', 'etc.', 'vs.', 'cf.', 'al.', 'approx.', 'est.',
  'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'st.',
  'inc.', 'ltd.', 'co.', 'corp.', 'dept.', 'univ.',
  'fig.', 'eq.', 'no.', 'vol.', 'pp.', 'ch.',
  'min.', 'max.', 'sec.', 'hrs.', 'approx.',
  'jan.', 'feb.', 'mar.', 'apr.', 'jun.', 'jul.', 'aug.', 'sep.', 'sept.', 'oct.', 'nov.', 'dec.',
]);
```

Create `apps/api/src/ingestion/sentences/segmenter.ts`:

```ts
/** A sentence and the half-open range it occupies in the text it came from. */
export interface Sentence {
  text: string;
  startChar: number;
  /** Exclusive. `text === input.slice(startChar, endChar)` always holds. */
  endChar: number;
}

export interface SentenceSegmenter {
  segment(text: string): Sentence[];
}

export interface SegmenterOptions {
  /**
   * A candidate boundary is rejected while the sentence so far is shorter than
   * this. Without it, "A. B. C." becomes three sentences and the chunker's
   * per-sentence bookkeeping fills with noise.
   */
  minSentenceChars: number;
  /**
   * A hard ceiling. Transcripts of unpunctuated speech would otherwise produce
   * a single unbounded "sentence" that R3 then turns into one enormous chunk.
   */
  maxSentenceChars: number;
}

export const DEFAULT_SEGMENTER_OPTIONS: SegmenterOptions = {
  minSentenceChars: 12,
  maxSentenceChars: 400,
};
```

Create `apps/api/src/ingestion/sentences/ruleBased.segmenter.ts`:

```ts
import { ABBREVIATIONS } from './abbreviations';
import {
  DEFAULT_SEGMENTER_OPTIONS,
  type SegmenterOptions,
  type Sentence,
  type SentenceSegmenter,
} from './segmenter';

const TERMINATORS = new Set(['.', '!', '?', '…']);
const OPENING_QUOTES = new Set(['"', "'", '“', '‘', '(', '[']);
/** Where a run that hits the ceiling may be cut, best first. */
const CLAUSE_BREAKS = [';', ',', ':', '—', '–'];

function isSpace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

/** The whitespace-delimited token ending at `end` (exclusive), lowercased. */
function tokenEndingAt(text: string, end: number): string {
  let start = end;
  while (start > 0 && !isSpace(text[start - 1])) start -= 1;
  return text.slice(start, end).toLowerCase();
}

/**
 * Proposes a boundary after every run of terminal punctuation and then rejects
 * it under the rules in spec §5.3. Stated as explicit rejections rather than a
 * regex so each rule is separately readable and separately testable.
 */
function acceptsBoundary(
  text: string,
  sentenceStart: number,
  punctuationStart: number,
  punctuationEnd: number,
  options: SegmenterOptions,
): boolean {
  // The sentence so far must be substantial — guards "A. B. C." and initials.
  if (punctuationEnd - sentenceStart < options.minSentenceChars) return false;

  const punctuation = text.slice(punctuationStart, punctuationEnd);
  const token = tokenEndingAt(text, punctuationEnd);

  // A known abbreviation's period belongs to the word.
  if (ABBREVIATIONS.has(token)) return false;

  // A single initial ("R.") is an abbreviation the list cannot enumerate.
  if (/^\p{L}\.$/u.test(token)) return false;

  let next = punctuationEnd;
  while (isSpace(text[next])) next += 1;
  const nextChar = text[next];

  // End of input: the caller emits the tail, so no boundary is needed here.
  if (nextChar === undefined) return false;

  // A decimal, a version, or an ordinal continues rather than ends: "3.5", "v4.2", "1. Introduction"
  // reaches here only when whitespace follows, so the digit test covers "3. 5".
  const previousChar = text[punctuationStart - 1];
  if (punctuation === '.' && previousChar !== undefined && /\d/.test(previousChar) && /\d/.test(nextChar)) {
    return false;
  }

  // An ellipsis before a lowercase word is a pause inside one thought.
  if (punctuation.length > 1 || punctuation === '…') {
    if (nextChar.toLowerCase() === nextChar && /\p{L}/u.test(nextChar)) return false;
  }

  // Anything that is not a new beginning is a continuation.
  const startsNewSentence =
    /\p{Lu}|\d/u.test(nextChar) || OPENING_QUOTES.has(nextChar);
  return startsNewSentence;
}

/** Trims the range, then emits it only if something is left. */
function pushRange(text: string, start: number, end: number, out: Sentence[]): void {
  let from = start;
  let to = end;
  while (from < to && isSpace(text[from])) from += 1;
  while (to > from && isSpace(text[to - 1])) to -= 1;
  if (to > from) out.push({ text: text.slice(from, to), startChar: from, endChar: to });
}

/**
 * Splits any range longer than the ceiling at the latest clause break that fits,
 * falling back to the latest space, and finally to a hard cut. Applied after
 * punctuation-based segmentation so it only ever fires on genuinely unpunctuated
 * speech.
 */
function pushCapped(text: string, start: number, end: number, out: Sentence[], max: number): void {
  let from = start;
  while (end - from > max) {
    const window = text.slice(from, from + max);
    let cut = -1;
    for (const mark of CLAUSE_BREAKS) {
      cut = Math.max(cut, window.lastIndexOf(mark) + (window.lastIndexOf(mark) >= 0 ? 1 : 0));
    }
    if (cut <= 0) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    pushRange(text, from, from + cut, out);
    from += cut;
  }
  pushRange(text, from, end, out);
}

export function createRuleBasedSegmenter(
  overrides: Partial<SegmenterOptions> = {},
): SentenceSegmenter {
  const options: SegmenterOptions = { ...DEFAULT_SEGMENTER_OPTIONS, ...overrides };

  return {
    segment(text: string): Sentence[] {
      const sentences: Sentence[] = [];
      let sentenceStart = 0;
      let cursor = 0;

      while (cursor < text.length) {
        const char = text[cursor];
        if (char === undefined || !TERMINATORS.has(char)) {
          cursor += 1;
          continue;
        }

        const punctuationStart = cursor;
        while (cursor < text.length) {
          const run = text[cursor];
          if (run === undefined || !TERMINATORS.has(run)) break;
          cursor += 1;
        }

        // A terminator must be followed by whitespace or end of input to end a
        // sentence; "3.5" and "example.com" are excluded here, not by a rule.
        const following = text[cursor];
        if (following !== undefined && !isSpace(following)) continue;

        if (acceptsBoundary(text, sentenceStart, punctuationStart, cursor, options)) {
          pushCapped(text, sentenceStart, cursor, sentences, options.maxSentenceChars);
          sentenceStart = cursor;
        }
      }

      pushCapped(text, sentenceStart, text.length, sentences, options.maxSentenceChars);
      return sentences;
    },
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test tests/unit/ingestion/segmenter.test.ts`
Expected: PASS (12 tests). If the capping test fails on an off-by-one, fix
`pushCapped` — the join of all sentence texts must reproduce the input with
single spaces, which is the invariant that test asserts.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ingestion/sentences tests/unit/ingestion/segmenter.test.ts
git commit -m "feat(ingestion): rule-based sentence segmenter with abbreviation and decimal guards"
```

---

## Task 6: Sentence reconstruction with millisecond spans

**Files:**
- Create: `apps/api/src/ingestion/sentences/reconstruct.ts`
- Test: `tests/unit/ingestion/reconstruct.test.ts`

**Interfaces:**
- Consumes: `NormalizedCue` (Task 2), `SentenceSegmenter` (Task 5)
- Produces: `interface ReconstructedSentence { index: number; text: string; startMs: number; endMs: number; gapAfterMs: number }` and `reconstructSentences(cues: NormalizedCue[], segmenter: SentenceSegmenter): ReconstructedSentence[]`. Task 8's chunker consumes exactly this array.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ingestion/reconstruct.test.ts`:

```ts
import { test, expect, describe } from 'bun:test';
import { reconstructSentences } from '../../../apps/api/src/ingestion/sentences/reconstruct';
import { createRuleBasedSegmenter } from '../../../apps/api/src/ingestion/sentences/ruleBased.segmenter';
import type { NormalizedCue } from '../../../apps/api/src/ingestion/parsers/types';

const segmenter = createRuleBasedSegmenter();

function cue(index: number, startMs: number, endMs: number, text: string): NormalizedCue {
  return { index, startMs, endMs, text, speaker: null };
}

describe('reconstructSentences', () => {
  test('a sentence spanning three cues takes the first start and the last end', () => {
    const sentences = reconstructSentences(
      [
        cue(0, 1000, 3000, 'So in this lecture we will create'),
        cue(1, 3000, 6000, 'some endpoints and then handle'),
        cue(2, 6000, 9000, 'different HTTP methods. Perfect.'),
      ],
      segmenter,
    );

    expect(sentences[0]).toMatchObject({
      text: 'So in this lecture we will create some endpoints and then handle different HTTP methods.',
      startMs: 1000,
      endMs: 9000,
    });
  });

  test('a sentence entirely inside one cue takes that cue span', () => {
    const sentences = reconstructSentences(
      [cue(0, 5000, 7000, 'This whole thought fits in one cue.'), cue(1, 8000, 9000, 'Next one here.')],
      segmenter,
    );
    expect(sentences[0]).toMatchObject({ startMs: 5000, endMs: 7000 });
  });

  test('a cue containing two sentence ends splits into two sentences sharing that cue', () => {
    const sentences = reconstructSentences(
      [cue(0, 1000, 4000, 'First thought is done. Second thought is also done.')],
      segmenter,
    );
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toMatchObject({ startMs: 1000, endMs: 4000 });
    expect(sentences[1]).toMatchObject({ startMs: 1000, endMs: 4000 });
  });

  test('gapAfterMs is the silence before the next sentence, and zero for the last', () => {
    const sentences = reconstructSentences(
      [
        cue(0, 1000, 3000, 'This is the first thought.'),
        cue(1, 5500, 7000, 'This is the second thought.'),
      ],
      segmenter,
    );
    expect(sentences[0]?.gapAfterMs).toBe(2500);
    expect(sentences[1]?.gapAfterMs).toBe(0);
  });

  test('clamps a negative gap to zero when cues overlap in time', () => {
    const sentences = reconstructSentences(
      [
        cue(0, 1000, 6000, 'This is the first thought.'),
        cue(1, 4000, 8000, 'This is the second thought.'),
      ],
      segmenter,
    );
    expect(sentences[0]?.gapAfterMs).toBe(0);
  });

  test('numbers sentences from zero in reading order', () => {
    const sentences = reconstructSentences(
      [cue(0, 0, 1000, 'One thought here. Two thoughts here. Three thoughts here.')],
      segmenter,
    );
    expect(sentences.map((sentence) => sentence.index)).toEqual([0, 1, 2]);
  });

  test('returns nothing for no cues', () => {
    expect(reconstructSentences([], segmenter)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test tests/unit/ingestion/reconstruct.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement reconstruction**

Create `apps/api/src/ingestion/sentences/reconstruct.ts`:

```ts
import type { NormalizedCue } from '../parsers/types';
import type { SentenceSegmenter } from './segmenter';

/** A sentence with the time span of every cue it touches (spec §5.2). */
export interface ReconstructedSentence {
  index: number;
  text: string;
  startMs: number;
  endMs: number;
  /** Silence until the next sentence starts; zero for the last one. */
  gapAfterMs: number;
}

interface CueRange {
  cue: NormalizedCue;
  startChar: number;
  /** Exclusive. */
  endChar: number;
}

/**
 * Subtitle cues split sentences at arbitrary points, so timing is recovered by
 * concatenating every cue, segmenting the result, and mapping each sentence's
 * character range back onto the cues it overlaps. A sentence that spans three
 * cues therefore carries the first cue's start and the last cue's end.
 */
export function reconstructSentences(
  cues: NormalizedCue[],
  segmenter: SentenceSegmenter,
): ReconstructedSentence[] {
  if (cues.length === 0) return [];

  const ranges: CueRange[] = [];
  let cursor = 0;
  const parts: string[] = [];

  for (const cue of cues) {
    if (cursor > 0) cursor += 1; // the single space joining cues
    ranges.push({ cue, startChar: cursor, endChar: cursor + cue.text.length });
    parts.push(cue.text);
    cursor += cue.text.length;
  }

  const fullText = parts.join(' ');
  const sentences = segmenter.segment(fullText);

  // The scan is a single forward sweep: sentences and cues are both ordered, so
  // the first overlapping cue never moves backwards.
  let firstCandidate = 0;
  const reconstructed: ReconstructedSentence[] = [];

  for (const sentence of sentences) {
    while (firstCandidate < ranges.length) {
      const range = ranges[firstCandidate];
      if (range === undefined || range.endChar > sentence.startChar) break;
      firstCandidate += 1;
    }

    let last = firstCandidate;
    while (last + 1 < ranges.length) {
      const next = ranges[last + 1];
      if (next === undefined || next.startChar >= sentence.endChar) break;
      last += 1;
    }

    const first = ranges[firstCandidate] ?? ranges[ranges.length - 1];
    const final = ranges[last] ?? first;
    if (first === undefined || final === undefined) continue;

    reconstructed.push({
      index: reconstructed.length,
      text: sentence.text,
      startMs: first.cue.startMs,
      endMs: final.cue.endMs,
      gapAfterMs: 0,
    });
  }

  for (let i = 0; i < reconstructed.length - 1; i += 1) {
    const current = reconstructed[i];
    const next = reconstructed[i + 1];
    if (current === undefined || next === undefined) continue;
    // Cues can overlap in time, which would make a raw difference negative;
    // a gap is a duration, so it floors at zero.
    current.gapAfterMs = Math.max(0, next.startMs - current.endMs);
  }

  return reconstructed;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test tests/unit/ingestion/reconstruct.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ingestion/sentences/reconstruct.ts tests/unit/ingestion/reconstruct.test.ts
git commit -m "feat(ingestion): reconstruct sentences with spans across cue boundaries"
```

---

## Task 7: Deterministic chunk identity

**Files:**
- Create: `apps/api/src/ingestion/chunking/chunkKey.ts`
- Test: `tests/unit/ingestion/chunkKey.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `interface ChunkKeyParts { cohortSlug: string; moduleSlug: string; classSlug: string; contentHash: string; chunkingVersion: string; embeddingModel: string; chunkIndex: number }` and `buildChunkKey(parts: ChunkKeyParts): string`. Task 8 calls it once per chunk.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ingestion/chunkKey.test.ts`:

```ts
import { test, expect, describe } from 'bun:test';
import { buildChunkKey } from '../../../apps/api/src/ingestion/chunking/chunkKey';

const parts = {
  cohortSlug: 'mobile-dev-cohort',
  moduleSlug: 'module-7',
  classSlug: '2-understanding-the-gyroscope',
  contentHash: '9f3a1c7d2e04b5a6f7c8d9e0a1b2c3d4',
  chunkingVersion: 'v1',
  embeddingModel: 'text-embedding-3-small',
  chunkIndex: 7,
};

describe('buildChunkKey', () => {
  test('matches the format documented in the spec', () => {
    expect(buildChunkKey(parts)).toBe(
      'mobile-dev-cohort:module-7:2-understanding-the-gyroscope:9f3a1c7d2e04:v1:text-embedding-3-small:0007',
    );
  });

  test('is stable across calls with identical input', () => {
    expect(buildChunkKey(parts)).toBe(buildChunkKey({ ...parts }));
  });

  test('changes when the chunking version changes', () => {
    expect(buildChunkKey({ ...parts, chunkingVersion: 'v2' })).not.toBe(buildChunkKey(parts));
  });

  test('changes when the embedding model changes', () => {
    expect(buildChunkKey({ ...parts, embeddingModel: 'text-embedding-3-large' })).not.toBe(
      buildChunkKey(parts),
    );
  });

  test('changes when the transcript content hash changes', () => {
    expect(buildChunkKey({ ...parts, contentHash: 'ffffffffffff0000' })).not.toBe(
      buildChunkKey(parts),
    );
  });

  test('zero-pads the index to four digits so keys sort lexicographically', () => {
    expect(buildChunkKey({ ...parts, chunkIndex: 0 }).endsWith(':0000')).toBe(true);
    expect(buildChunkKey({ ...parts, chunkIndex: 42 }).endsWith(':0042')).toBe(true);
    expect(buildChunkKey({ ...parts, chunkIndex: 1234 }).endsWith(':1234')).toBe(true);
  });

  test('rejects a component containing the separator', () => {
    expect(() => buildChunkKey({ ...parts, classSlug: 'a:b' })).toThrow(/classSlug/);
  });

  test('rejects an empty component', () => {
    expect(() => buildChunkKey({ ...parts, cohortSlug: '' })).toThrow(/cohortSlug/);
  });

  test('rejects a content hash too short to truncate', () => {
    expect(() => buildChunkKey({ ...parts, contentHash: 'abc' })).toThrow(/contentHash/);
  });

  test('rejects a negative or fractional index', () => {
    expect(() => buildChunkKey({ ...parts, chunkIndex: -1 })).toThrow(/chunkIndex/);
    expect(() => buildChunkKey({ ...parts, chunkIndex: 1.5 })).toThrow(/chunkIndex/);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test tests/unit/ingestion/chunkKey.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the chunk key**

Create `apps/api/src/ingestion/chunking/chunkKey.ts`:

```ts
export interface ChunkKeyParts {
  cohortSlug: string;
  moduleSlug: string;
  classSlug: string;
  /** Full transcript content hash; the key carries its first 12 characters. */
  contentHash: string;
  chunkingVersion: string;
  embeddingModel: string;
  chunkIndex: number;
}

const SEPARATOR = ':';
const HASH_PREFIX_LENGTH = 12;
const INDEX_DIGITS = 4;

function requireComponent(name: string, value: string): string {
  if (value.length === 0) {
    throw new Error(`chunk_key component ${name} must not be empty.`);
  }
  if (value.includes(SEPARATOR)) {
    throw new Error(
      `chunk_key component ${name} must not contain "${SEPARATOR}" (received "${value}").`,
    );
  }
  return value;
}

/**
 * Human-readable on purpose: a chunk id in a log names the cohort, module,
 * class, transcript version, and position without a database lookup. It is also
 * the UNIQUE column that makes re-ingesting identical bytes a no-op, so it must
 * be a pure function of content — never of a clock, a counter, or a row id
 * (spec §5.4).
 */
export function buildChunkKey(parts: ChunkKeyParts): string {
  if (!Number.isInteger(parts.chunkIndex) || parts.chunkIndex < 0) {
    throw new Error(
      `chunk_key component chunkIndex must be a non-negative integer (received ${parts.chunkIndex}).`,
    );
  }
  if (parts.contentHash.length < HASH_PREFIX_LENGTH) {
    throw new Error(
      `chunk_key component contentHash must be at least ${HASH_PREFIX_LENGTH} characters.`,
    );
  }

  return [
    requireComponent('cohortSlug', parts.cohortSlug),
    requireComponent('moduleSlug', parts.moduleSlug),
    requireComponent('classSlug', parts.classSlug),
    requireComponent('contentHash', parts.contentHash.slice(0, HASH_PREFIX_LENGTH)),
    requireComponent('chunkingVersion', parts.chunkingVersion),
    requireComponent('embeddingModel', parts.embeddingModel),
    // Padding keeps keys in chunk order under a lexicographic sort. A
    // transcript past 9999 chunks simply widens the field rather than wrapping.
    String(parts.chunkIndex).padStart(INDEX_DIGITS, '0'),
  ].join(SEPARATOR);
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test tests/unit/ingestion/chunkKey.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ingestion/chunking/chunkKey.ts tests/unit/ingestion/chunkKey.test.ts
git commit -m "feat(ingestion): deterministic human-readable chunk keys"
```

---

## Task 8: The chunker (rules R1–R8)

**Files:**
- Create: `apps/api/src/ingestion/chunking/chunker.ts`
- Create: `apps/api/src/ingestion/index.ts`
- Test: `tests/unit/ingestion/chunker.test.ts`

**Interfaces:**
- Consumes: `ReconstructedSentence` (Task 6), `buildChunkKey` (Task 7), `Tokenizer` (Task 1), `RagConfig['chunking']` from `apps/api/src/config/rag.ts`
- Produces: `type ChunkingConfig = RagConfig['chunking']`, `interface ChunkContext { cohortSlug; moduleSlug; classSlug; contentHash; embeddingModel }`, `interface PreparedChunk { chunkKey; chunkIndex; text; startMs; endMs; tokenCount; sentenceCount; overlapSentenceCount; chunkingVersion; tokenizer; embeddingModel }`, `interface ChunkingResult { chunks: PreparedChunk[]; stats: { sentenceCount: number; oversizedSentences: number; gapBoundariesUsed: number } }`, and `chunkSentences(sentences, ctx, config, tokenizer): ChunkingResult`. Phase 3 persists `PreparedChunk` fields directly into the `chunks` table.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ingestion/chunker.test.ts`:

```ts
import { test, expect, describe } from 'bun:test';
import {
  chunkSentences,
  type ChunkContext,
  type ChunkingConfig,
} from '../../../apps/api/src/ingestion/chunking/chunker';
import type { ReconstructedSentence } from '../../../apps/api/src/ingestion/sentences/reconstruct';
import type { Tokenizer } from '../../../apps/api/src/ingestion/tokenizer/tokenizer';

/**
 * One token per whitespace-delimited word. Deterministic and legible, which
 * lets these tests state exact sizes; the real encoder is proven in its own
 * suite and injected identically.
 */
const wordTokenizer: Tokenizer = {
  name: 'test-words',
  count: (text) => (text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length),
};

const config: ChunkingConfig = {
  version: 'v1',
  targetTokens: 500,
  minTokens: 350,
  maxTokens: 650,
  overlapRatio: 0.125,
  gapPreferredMs: 2000,
  tokenizerEncoding: 'test-words',
};

const ctx: ChunkContext = {
  cohortSlug: 'mobile-dev-cohort',
  moduleSlug: 'module-7',
  classSlug: 'gyroscope',
  contentHash: '9f3a1c7d2e04b5a6',
  embeddingModel: 'text-embedding-3-small',
};

/** A sentence of `tokens` words, uniquely worded so chunk text is traceable. */
function sentence(
  index: number,
  tokens: number,
  options: { gapAfterMs?: number; startMs?: number; endMs?: number } = {},
): ReconstructedSentence {
  const startMs = options.startMs ?? index * 1000;
  return {
    index,
    text: Array.from({ length: tokens }, (_, word) => `s${index}w${word}`).join(' '),
    startMs,
    endMs: options.endMs ?? startMs + 900,
    gapAfterMs: options.gapAfterMs ?? 100,
  };
}

function series(count: number, tokens: number, gapAfterMs = 100): ReconstructedSentence[] {
  return Array.from({ length: count }, (_, index) => sentence(index, tokens, { gapAfterMs }));
}

describe('chunkSentences — sizes and sentence atomicity', () => {
  test('a typical transcript lands inside the 350–650 window', () => {
    const { chunks } = chunkSentences(series(120, 20), ctx, config, wordTokenizer);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.tokenCount).toBeGreaterThanOrEqual(config.minTokens);
      expect(chunk.tokenCount).toBeLessThanOrEqual(config.maxTokens);
    }
  });

  test('no chunk boundary ever falls inside a sentence', () => {
    const sentences = series(120, 20);
    const { chunks } = chunkSentences(sentences, ctx, config, wordTokenizer);
    const known = new Set(sentences.map((item) => item.text));
    for (const chunk of chunks) {
      // Rebuilding the chunk from whole known sentences must consume it exactly.
      let remaining = chunk.text;
      while (remaining.length > 0) {
        const match = [...known].find((text) => remaining.startsWith(text));
        expect(match).toBeDefined();
        remaining = remaining.slice((match ?? '').length).replace(/^ /, '');
      }
    }
  });

  test('R3: a sentence larger than maxTokens becomes its own intact chunk', () => {
    const sentences = [sentence(0, 100), sentence(1, 900), sentence(2, 100)];
    const { chunks, stats } = chunkSentences(sentences, ctx, config, wordTokenizer);
    const giant = chunks.find((chunk) => chunk.tokenCount === 900);
    expect(giant).toBeDefined();
    expect(giant?.sentenceCount).toBe(1);
    expect(giant?.text).toBe(sentences[1]?.text);
    expect(stats.oversizedSentences).toBe(1);
  });

  test('R4: a 2.5s gap past minTokens splits, and the same gap early does not', () => {
    const late = series(40, 10);
    const lateBreak = late[39];
    if (lateBreak === undefined) throw new Error('fixture');
    lateBreak.gapAfterMs = 2500;
    const lateResult = chunkSentences([...late, ...series(20, 10)], ctx, config, wordTokenizer);
    expect(lateResult.stats.gapBoundariesUsed).toBe(1);
    expect(lateResult.chunks[0]?.tokenCount).toBe(400);

    const early = series(60, 10);
    const earlyBreak = early[2];
    if (earlyBreak === undefined) throw new Error('fixture');
    earlyBreak.gapAfterMs = 2500;
    const earlyResult = chunkSentences(early, ctx, config, wordTokenizer);
    expect(earlyResult.stats.gapBoundariesUsed).toBe(0);
    expect(earlyResult.chunks[0]?.tokenCount).toBeGreaterThanOrEqual(config.minTokens);
  });

  test('R5: an under-minimum chunk takes the next sentence even when it overshoots', () => {
    // 300 tokens, then a 400-token sentence: below minTokens, so it is added.
    const sentences = [sentence(0, 300), sentence(1, 400), sentence(2, 50)];
    const { chunks } = chunkSentences(sentences, ctx, config, wordTokenizer);
    expect(chunks[0]?.tokenCount).toBe(700);
    expect(chunks[0]?.sentenceCount).toBe(2);
  });

  test('R5: a chunk past minTokens flushes rather than exceeding maxTokens', () => {
    const sentences = [sentence(0, 360), sentence(1, 400), sentence(2, 50)];
    const { chunks } = chunkSentences(sentences, ctx, config, wordTokenizer);
    expect(chunks[0]?.tokenCount).toBe(360);
  });

  test('R8: the final chunk may fall below minTokens and is never padded', () => {
    const { chunks } = chunkSentences(series(53, 10), ctx, config, wordTokenizer);
    const last = chunks[chunks.length - 1];
    expect(last).toBeDefined();
    expect(last?.tokenCount).toBeLessThan(config.minTokens);
  });

  test('R7: overlap is whole sentences within the ratio and always moves forward', () => {
    const sentences = series(200, 10);
    const { chunks } = chunkSentences(sentences, ctx, config, wordTokenizer);
    expect(chunks.length).toBeGreaterThan(2);
    for (const [position, chunk] of chunks.entries()) {
      if (position === 0) {
        expect(chunk.overlapSentenceCount).toBe(0);
        continue;
      }
      const previous = chunks[position - 1];
      if (previous === undefined) throw new Error('unreachable');
      const overlapTokens = chunk.overlapSentenceCount * 10;
      expect(overlapTokens).toBeLessThanOrEqual(config.overlapRatio * previous.tokenCount);
      expect(chunk.overlapSentenceCount).toBeLessThan(previous.sentenceCount);
      expect(chunk.startMs).toBeLessThan(previous.endMs + 1);
    }
    // Forward progress: every sentence appears, indices strictly increase.
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });

  test('timestamps span first to last sentence, and consecutive chunks may overlap', () => {
    const { chunks } = chunkSentences(series(120, 20), ctx, config, wordTokenizer);
    for (const chunk of chunks) {
      expect(chunk.endMs).toBeGreaterThanOrEqual(chunk.startMs);
    }
    const [first, second] = chunks;
    if (first === undefined || second === undefined) throw new Error('need two chunks');
    expect(second.startMs).toBeLessThan(first.endMs);
  });
});

describe('chunkSentences — edges', () => {
  test('an empty transcript yields no chunks and zeroed stats', () => {
    expect(chunkSentences([], ctx, config, wordTokenizer)).toEqual({
      chunks: [],
      stats: { sentenceCount: 0, oversizedSentences: 0, gapBoundariesUsed: 0 },
    });
  });

  test('a single short sentence yields exactly one chunk', () => {
    const { chunks } = chunkSentences([sentence(0, 4)], ctx, config, wordTokenizer);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.tokenCount).toBe(4);
    expect(chunks[0]?.sentenceCount).toBe(1);
  });

  test('very short sentences still accumulate into full-size chunks', () => {
    const { chunks } = chunkSentences(series(400, 2), ctx, config, wordTokenizer);
    expect(chunks[0]?.tokenCount).toBeGreaterThanOrEqual(config.minTokens);
  });

  test('one long unpunctuated paragraph becomes one oversized chunk', () => {
    const { chunks, stats } = chunkSentences([sentence(0, 2000)], ctx, config, wordTokenizer);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.tokenCount).toBe(2000);
    expect(stats.oversizedSentences).toBe(1);
  });
});

describe('chunkSentences — identity and determinism', () => {
  test('identical input produces identical chunk keys', () => {
    const input = series(60, 20);
    const first = chunkSentences(input, ctx, config, wordTokenizer);
    const second = chunkSentences(series(60, 20), ctx, config, wordTokenizer);
    expect(first.chunks.map((chunk) => chunk.chunkKey)).toEqual(
      second.chunks.map((chunk) => chunk.chunkKey),
    );
  });

  test('changing the chunking version or embedding model changes every key', () => {
    const input = series(60, 20);
    const base = chunkSentences(input, ctx, config, wordTokenizer).chunks[0]?.chunkKey;
    const versioned = chunkSentences(input, ctx, { ...config, version: 'v2' }, wordTokenizer)
      .chunks[0]?.chunkKey;
    const remodelled = chunkSentences(
      input,
      { ...ctx, embeddingModel: 'text-embedding-3-large' },
      config,
      wordTokenizer,
    ).chunks[0]?.chunkKey;
    expect(versioned).not.toBe(base);
    expect(remodelled).not.toBe(base);
  });

  test('records the persistence metadata every chunk row needs', () => {
    const { chunks } = chunkSentences(series(60, 20), ctx, config, wordTokenizer);
    expect(chunks[0]).toMatchObject({
      chunkingVersion: 'v1',
      tokenizer: 'test-words',
      embeddingModel: 'text-embedding-3-small',
      chunkIndex: 0,
    });
  });

  test('reports sentence count in stats', () => {
    expect(chunkSentences(series(37, 10), ctx, config, wordTokenizer).stats.sentenceCount).toBe(37);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test tests/unit/ingestion/chunker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the chunker**

Create `apps/api/src/ingestion/chunking/chunker.ts`:

```ts
import type { RagConfig } from '../../config/rag';
import type { ReconstructedSentence } from '../sentences/reconstruct';
import type { Tokenizer } from '../tokenizer/tokenizer';
import { buildChunkKey } from './chunkKey';

export type ChunkingConfig = RagConfig['chunking'];

/** Everything the chunk key needs that the sentences themselves do not carry. */
export interface ChunkContext {
  cohortSlug: string;
  moduleSlug: string;
  classSlug: string;
  contentHash: string;
  embeddingModel: string;
}

/** A chunk ready to persist. Field names mirror the `chunks` table. */
export interface PreparedChunk {
  chunkKey: string;
  chunkIndex: number;
  text: string;
  startMs: number;
  endMs: number;
  tokenCount: number;
  sentenceCount: number;
  overlapSentenceCount: number;
  chunkingVersion: string;
  tokenizer: string;
  embeddingModel: string;
}

export interface ChunkingResult {
  chunks: PreparedChunk[];
  stats: {
    sentenceCount: number;
    oversizedSentences: number;
    gapBoundariesUsed: number;
  };
}

interface Measured {
  sentence: ReconstructedSentence;
  tokens: number;
}

/**
 * The documented rule set from spec §6.1, in rule order. Pure and synchronous:
 * no clock, no randomness, no I/O. Identical input yields byte-identical
 * output, which is what lets Phase 3 re-ingest with ON CONFLICT DO NOTHING and
 * change nothing.
 *
 * R1 is structural rather than checked: the function takes the sentences of
 * exactly one transcript, so a chunk spanning two classes is unrepresentable.
 */
export function chunkSentences(
  sentences: ReconstructedSentence[],
  ctx: ChunkContext,
  config: ChunkingConfig,
  tokenizer: Tokenizer,
): ChunkingResult {
  const chunks: PreparedChunk[] = [];
  const stats = { sentenceCount: sentences.length, oversizedSentences: 0, gapBoundariesUsed: 0 };

  let open: Measured[] = [];
  let openTokens = 0;
  let openOverlapCount = 0;

  const emit = (): void => {
    const first = open[0];
    const last = open[open.length - 1];
    if (first === undefined || last === undefined) return;

    const chunkIndex = chunks.length;
    chunks.push({
      chunkKey: buildChunkKey({
        cohortSlug: ctx.cohortSlug,
        moduleSlug: ctx.moduleSlug,
        classSlug: ctx.classSlug,
        contentHash: ctx.contentHash,
        chunkingVersion: config.version,
        embeddingModel: ctx.embeddingModel,
        chunkIndex,
      }),
      chunkIndex,
      text: open.map((item) => item.sentence.text).join(' '),
      // R6.2: the span of the sentences actually included, overlap and all.
      startMs: first.sentence.startMs,
      endMs: last.sentence.endMs,
      // The same measure the rules were enforced against, so a chunk's recorded
      // size always agrees with the boundary decisions that produced it.
      tokenCount: openTokens,
      sentenceCount: open.length,
      overlapSentenceCount: openOverlapCount,
      chunkingVersion: config.version,
      tokenizer: tokenizer.name,
      embeddingModel: ctx.embeddingModel,
    });
  };

  /**
   * R7: seed the next chunk with trailing sentences of the one just closed,
   * within `overlapRatio × previousChunkTokens` and capped at one fewer than
   * the previous sentence count so the next chunk always contains something new.
   */
  const flush = (): void => {
    if (open.length === 0) return;
    emit();

    const budget = config.overlapRatio * openTokens;
    const maxSentences = Math.max(0, open.length - 1);
    const carried: Measured[] = [];
    let carriedTokens = 0;

    for (let i = open.length - 1; i >= 0 && carried.length < maxSentences; i -= 1) {
      const candidate = open[i];
      if (candidate === undefined) break;
      if (carriedTokens + candidate.tokens > budget) break;
      carried.unshift(candidate);
      carriedTokens += candidate.tokens;
    }

    open = carried;
    openTokens = carriedTokens;
    openOverlapCount = carried.length;
  };

  for (const sentence of sentences) {
    const tokens = tokenizer.count(sentence.text);

    // R3: an oversized sentence is kept whole as its own chunk.
    if (tokens > config.maxTokens) {
      flush();
      // The seeded overlap belongs to the previous chunk's tail, not to a
      // sentence that must stand alone; drop it and emit the sentence intact.
      open = [{ sentence, tokens }];
      openTokens = tokens;
      openOverlapCount = 0;
      stats.oversizedSentences += 1;
      flush();
      continue;
    }

    // R5: flush before overflowing, but only once the chunk is worth flushing.
    if (
      open.length > 0 &&
      openTokens + tokens > config.maxTokens &&
      openTokens >= config.minTokens
    ) {
      flush();
    }

    open.push({ sentence, tokens });
    openTokens += tokens;

    // R4: a real pause is the preferred boundary — but only past the minimum,
    // which is what keeps an early pause from producing a tiny chunk.
    if (openTokens >= config.minTokens && sentence.gapAfterMs >= config.gapPreferredMs) {
      stats.gapBoundariesUsed += 1;
      flush();
      continue;
    }

    // R6: otherwise close at the target size.
    if (openTokens >= config.targetTokens) flush();
  }

  // R8: the tail is emitted as-is — never merged backwards, never padded.
  if (open.length > 0) emit();

  return { chunks, stats };
}
```

Note the R7 subtlety the tests pin down: after the final `flush()` inside the
loop the `open` array holds only carried-over sentences. Emitting that as a
chunk would duplicate content already persisted, so the tail is emitted only
when `open` contains at least one sentence that has not been emitted. Guard it:
track `pendingNew` — set `false` by `flush()`, `true` by every `open.push`, and
require it in the final emit.

Apply that guard now rather than after the test fails:

```ts
  let pendingNew = false;
  // ...in flush(): pendingNew = false;  after `open = carried`
  // ...after each `open.push(...)`: pendingNew = true;
  // ...final: if (open.length > 0 && pendingNew) emit();
```

Create `apps/api/src/ingestion/index.ts`:

```ts
export { parseTranscript, detectFormat, TranscriptParseError } from './parsers';
export type { NormalizedCue, TranscriptFormat } from './parsers/types';
export { createRuleBasedSegmenter } from './sentences/ruleBased.segmenter';
export type { SentenceSegmenter, Sentence } from './sentences/segmenter';
export { reconstructSentences } from './sentences/reconstruct';
export type { ReconstructedSentence } from './sentences/reconstruct';
export { chunkSentences } from './chunking/chunker';
export type {
  ChunkContext,
  ChunkingConfig,
  ChunkingResult,
  PreparedChunk,
} from './chunking/chunker';
export { buildChunkKey } from './chunking/chunkKey';
export type { ChunkKeyParts } from './chunking/chunkKey';
export { createTokenizer } from './tokenizer/tokenizer';
export type { Tokenizer } from './tokenizer/tokenizer';
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test tests/unit/ingestion/chunker.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Run the whole suite**

Run: `bun test`
Expected: every unit test passes; integration tests skip without `TEST_DATABASE_URL`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/ingestion/chunking/chunker.ts apps/api/src/ingestion/index.ts tests/unit/ingestion/chunker.test.ts
git commit -m "feat(ingestion): deterministic chunker implementing rules R1-R8"
```

---

## Task 9: Hand-inspection of a real class

**Files:**
- Create: `apps/api/scripts/inspect-chunks.ts`
- Modify: `package.json` (add the `inspect:chunks` script)

**Interfaces:**
- Consumes: the whole `apps/api/src/ingestion` barrel from Task 8
- Produces: a CLI that prints one line per chunk plus a size histogram. This is the §24 done-criterion for Phase 2 — "chunker output on a real class inspected by hand" — and the first end-to-end exercise of parse → reconstruct → chunk.

- [ ] **Step 1: Write the script**

Create `apps/api/scripts/inspect-chunks.ts`:

```ts
/**
 * Inspect chunker output for one transcript file.
 *
 *   bun run inspect:chunks "recordings/class-subtitle/module 5/<class>/<file>.srt"
 *
 * Prints one row per chunk plus a size summary. Reads a file and writes to
 * stdout, which is why it lives in scripts/ rather than src/ — everything it
 * calls is pure.
 */
import {
  chunkSentences,
  createRuleBasedSegmenter,
  createTokenizer,
  parseTranscript,
  reconstructSentences,
} from '../src/ingestion/index';
import { loadEnv } from '../src/config/env.schema';
import { buildRagConfig } from '../src/config/rag';

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: bun run inspect:chunks <path-to-.srt-or-.vtt>');
  process.exit(1);
}

const content = await Bun.file(path).text();
const fileName = path.split('/').pop() ?? path;

// The script only needs chunking settings, so the required secrets are stubbed.
const config = buildRagConfig(
  loadEnv({ ...process.env, DATABASE_URL: 'postgres://inspect', OPENAI_API_KEY: 'inspect' }),
);
const tokenizer = createTokenizer(config.chunking.tokenizerEncoding);

const cues = parseTranscript(fileName, content);
const sentences = reconstructSentences(cues, createRuleBasedSegmenter());
const hash = new Bun.CryptoHasher('sha256').update(content).digest('hex');

const { chunks, stats } = chunkSentences(
  sentences,
  {
    cohortSlug: 'inspect-cohort',
    moduleSlug: 'inspect-module',
    classSlug: 'inspect-class',
    contentHash: hash,
    embeddingModel: config.embedding.model,
  },
  config.chunking,
  tokenizer,
);

const clock = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
};

console.log(`file        ${fileName}`);
console.log(`cues        ${cues.length}`);
console.log(`sentences   ${stats.sentenceCount}`);
console.log(`chunks      ${chunks.length}`);
console.log(`oversized   ${stats.oversizedSentences}`);
console.log(`gap breaks  ${stats.gapBoundariesUsed}`);
console.log('');
console.log('  #  tokens  sents  ovl  span            preview');

for (const chunk of chunks) {
  console.log(
    [
      String(chunk.chunkIndex).padStart(3),
      String(chunk.tokenCount).padStart(7),
      String(chunk.sentenceCount).padStart(6),
      String(chunk.overlapSentenceCount).padStart(4),
      `  ${clock(chunk.startMs)}–${clock(chunk.endMs)}`.padEnd(16),
      chunk.text.slice(0, 60).replace(/\s+/g, ' '),
    ].join(' '),
  );
}

const sizes = chunks.map((chunk) => chunk.tokenCount);
const inWindow = sizes.filter(
  (size) => size >= config.chunking.minTokens && size <= config.chunking.maxTokens,
).length;
console.log('');
console.log(
  `sizes  min ${Math.min(...sizes)}  max ${Math.max(...sizes)}  ` +
    `mean ${Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)}  ` +
    `in ${config.chunking.minTokens}–${config.chunking.maxTokens}: ${inWindow}/${sizes.length}`,
);
```

Add to root `package.json` scripts:

```json
    "inspect:chunks": "bun run apps/api/scripts/inspect-chunks.ts"
```

- [ ] **Step 2: Run it on a real class and read the output**

```bash
bun run inspect:chunks "recordings/class-subtitle/module 5/2. Creating apis routes and calling from client side of screen_epm/2. Creating apis routes and calling from client side of screen_epm.srt"
```

Check by eye, and fix the chunker if any of these fail:
- every chunk except the last sits in 350–650 tokens
- no preview text begins or ends mid-word
- `ovl` is non-zero for every chunk after the first, and smaller than that chunk's `sents`
- spans increase monotonically and consecutive spans overlap slightly

- [ ] **Step 3: Run it on the VTT twin of the same class**

```bash
bun run inspect:chunks "recordings/class-subtitle/module 5/2. Creating apis routes and calling from client side of screen_epm/2. Creating apis routes and calling from client side of screen_epm.vtt"
```

The two formats carry the same speech, so chunk count and sizes should be
near-identical. A large divergence means one parser is dropping or merging cues.

- [ ] **Step 4: Run the full suite and the type checker**

```bash
bun test
bunx tsc --noEmit
```
Expected: all tests pass; no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/scripts/inspect-chunks.ts package.json
git commit -m "feat(ingestion): chunk inspection script for hand-checking a real class"
```

---

## Phase 2 Done Criteria (spec §24)

- [ ] Every §18.1 unit case for parsing, format detection, segmentation, reconstruction, chunking, chunk identity, and the tokenizer passes under `bun test`
- [ ] `bunx tsc --noEmit` is clean
- [ ] Chunker output on a real class has been inspected by hand via `bun run inspect:chunks`
- [ ] No module in `apps/api/src/ingestion/**` performs I/O, reads a clock, or uses randomness
