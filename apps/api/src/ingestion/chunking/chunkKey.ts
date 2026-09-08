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
    // Padding keeps keys in chunk order under a lexicographic sort. A transcript
    // past 9999 chunks simply widens the field rather than wrapping.
    String(parts.chunkIndex).padStart(INDEX_DIGITS, '0'),
  ].join(SEPARATOR);
}
