import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { AppError } from '../errors/AppError';

export interface TranscriptSourceContent {
  content: string;
  byteSize: number;
  contentHash: string;
}

/**
 * Abstracted so V2 can swap in object storage without touching the ingestion
 * workflow. The filesystem implementation is the only one V1 needs.
 */
export interface TranscriptSource {
  read(sourceUri: string): Promise<TranscriptSourceContent>;
}

const OUTSIDE_ROOTS = 'Transcript source path is outside the allowed roots.';
const UNREADABLE = 'Transcript source could not be read.';

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * `sourceUri` reaches this from an HTTP request, so containment is enforced on
 * the *real* path: resolve() alone normalizes `..` but still follows a symlink
 * planted inside a root out to anywhere on disk. Neither rejection echoes the
 * attempted path back to the caller.
 */
export function createFileTranscriptSource(allowedRoots: string[]): TranscriptSource {
  return {
    read: async (sourceUri: string) => {
      // No roots means nothing is readable — fail closed rather than open.
      if (allowedRoots.length === 0) throw new AppError('VALIDATION_ERROR', OUTSIDE_ROOTS);

      const requested = resolve(sourceUri);
      if (!allowedRoots.some((root) => contains(resolve(root), requested))) {
        throw new AppError('VALIDATION_ERROR', OUTSIDE_ROOTS);
      }

      // A path that does not exist cannot be resolved to a real path; that is a
      // missing file, not an escape attempt.
      let real: string;
      let realRoots: string[];
      try {
        real = await realpath(requested);
        realRoots = await Promise.all(allowedRoots.map((root) => realpath(resolve(root))));
      } catch {
        throw new AppError('NOT_FOUND', UNREADABLE);
      }

      if (!realRoots.some((root) => contains(root, real))) {
        throw new AppError('VALIDATION_ERROR', OUTSIDE_ROOTS);
      }

      try {
        const content = await Bun.file(real).text();
        const hasher = new Bun.CryptoHasher('sha256');
        hasher.update(content);
        return {
          content,
          byteSize: Buffer.byteLength(content, 'utf8'),
          contentHash: hasher.digest('hex'),
        };
      } catch {
        throw new AppError('NOT_FOUND', UNREADABLE);
      }
    },
  };
}
