import { getEncoding, type Tiktoken, type TiktokenEncoding } from 'js-tiktoken';
import { ConfigError } from '../../config/env.schema';

/**
 * Token counting is injected rather than imported so the chunker stays pure and
 * testable with a trivial fake. Counts must come from a real BPE encoder: a
 * character-length estimate drifts by 20%+ on transcript prose, which would put
 * chunks outside the 350-650 window the retrieval budget assumes (spec §6).
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
