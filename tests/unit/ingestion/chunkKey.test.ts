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
