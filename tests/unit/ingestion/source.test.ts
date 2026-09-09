import { test, expect, describe, afterEach } from 'bun:test';
import { createFileTranscriptSource } from '../../../apps/api/src/ingestion/source';
import { AppError } from '../../../apps/api/src/errors/AppError';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('createFileTranscriptSource', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('reads a real file and returns its exact content', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-'));
    const filePath = join(tempDir, 'test.txt');
    const content = 'Hello, world!';
    writeFileSync(filePath, content);

    const source = createFileTranscriptSource([tempDir]);
    const result = await source.read(filePath);

    expect(result.content).toBe(content);
  });

  test('contentHash matches a hash computed independently and is stable across reads', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-'));
    const filePath = join(tempDir, 'test.txt');
    const content = 'Stable hash test content';
    writeFileSync(filePath, content);

    const source = createFileTranscriptSource([tempDir]);
    const result1 = await source.read(filePath);
    const result2 = await source.read(filePath);

    // Verify hash is stable across reads
    expect(result1.contentHash).toBe(result2.contentHash);

    // Verify hash matches independently computed hash
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(content);
    const expectedHash = hasher.digest('hex');
    expect(result1.contentHash).toBe(expectedHash);
  });

  test('byteSize counts BYTES not characters with multi-byte UTF-8', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-'));
    const filePath = join(tempDir, 'test.txt');
    // The character "é" is 2 bytes in UTF-8, "→" is 3 bytes
    const content = 'café→restaurant';
    writeFileSync(filePath, content, 'utf8');

    const source = createFileTranscriptSource([tempDir]);
    const result = await source.read(filePath);

    // Verify byteSize is in bytes, not characters
    expect(result.content).toBe(content);
    expect(result.content.length).toBeLessThan(result.byteSize);

    // Manually verify byte count
    const expectedByteSize = Buffer.byteLength(content, 'utf8');
    expect(result.byteSize).toBe(expectedByteSize);
  });

  test('rejects a path outside allowed roots with error message not echoing the path', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-'));
    const maliciousPath = '/etc/passwd';

    const source = createFileTranscriptSource([tempDir]);

    try {
      await source.read(maliciousPath);
      throw new Error('expected AppError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const error = err as AppError;
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toBe('Transcript source path is outside the allowed roots.');
      // Verify the malicious path is NOT in the error message
      expect(error.message).not.toContain('/etc/passwd');
    }
  });

  test('rejects a .. traversal that resolves outside the root', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-'));
    const subdir = join(tempDir, 'subdir');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(subdir, 'file.txt'), 'content');

    // Try to traverse up and out
    const traversalPath = join(subdir, '..', '..', '..', 'etc', 'passwd');

    const source = createFileTranscriptSource([subdir]);

    try {
      await source.read(traversalPath);
      throw new Error('expected AppError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const error = err as AppError;
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toBe('Transcript source path is outside the allowed roots.');
    }
  });

  test('throws NOT_FOUND for missing file inside allowed root', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-'));
    const missingPath = join(tempDir, 'does-not-exist.txt');

    const source = createFileTranscriptSource([tempDir]);

    try {
      await source.read(missingPath);
      throw new Error('expected AppError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const error = err as AppError;
      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toBe('Transcript source could not be read.');
    }
  });

  test('rejects everything when allowedRoots is empty', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-'));
    const filePath = join(tempDir, 'test.txt');
    writeFileSync(filePath, 'content');

    const source = createFileTranscriptSource([]);

    try {
      await source.read(filePath);
      throw new Error('expected AppError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const error = err as AppError;
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toBe('Transcript source path is outside the allowed roots.');
    }
  });

  test('reads from an existing root even when another allowed root does not exist', async () => {
    // Regression: uploads/ does not exist until the first upload, and resolving
    // every root in one Promise.all made that absent root reject the batch, so
    // every transcript under recordings/ failed as NOT_FOUND and all ingestion
    // silently stopped.
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-'));
    const filePath = join(tempDir, 'test.txt');
    writeFileSync(filePath, 'content');
    const absentRoot = join(tempDir, 'never-created');

    const source = createFileTranscriptSource([absentRoot, tempDir]);

    expect((await source.read(filePath)).content).toBe('content');
  });

  test('rejects everything when every allowed root is absent', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-'));
    const filePath = join(tempDir, 'test.txt');
    writeFileSync(filePath, 'content');

    // Tolerating absent roots must not degrade into tolerating *no* roots.
    const source = createFileTranscriptSource([join(tempDir, 'absent-a'), join(tempDir, 'absent-b')]);

    await expect(source.read(filePath)).rejects.toThrow(/outside the allowed roots/);
  });

test('rejects a symlink inside an allowed root that points outside it', async () => {
  // resolve() alone cannot catch this: the path is textually inside the root
  // and only the real path reveals the escape.
  const root = mkdtempSync(join(tmpdir(), 'source-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'source-outside-'));
  const secret = join(outside, 'secret.srt');
  writeFileSync(secret, 'classified');
  const link = join(root, 'innocent.srt');
  symlinkSync(secret, link);

  const source = createFileTranscriptSource([root]);
  await expect(source.read(link)).rejects.toThrow(/outside the allowed roots/);

  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
});
