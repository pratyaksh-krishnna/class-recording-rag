import { resolve } from 'node:path';
import { AppError } from '../errors/AppError';

export interface TranscriptSourceContent {
  content: string;
  byteSize: number;
  contentHash: string;
}

/**
 * Abstracted transcript source to allow V2 to swap in object storage (S3, etc.)
 * without touching the ingestion workflow. Currently reads from the filesystem.
 */
export interface TranscriptSource {
  read(sourceUri: string): Promise<TranscriptSourceContent>;
}

export function createFileTranscriptSource(allowedRoots: string[]): TranscriptSource {
  return {
    read: async (sourceUri: string) => {
      // Reject if no roots are allowed (fail closed).
      if (allowedRoots.length === 0) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Transcript source path is outside the allowed roots.',
        );
      }

      const resolvedUri = resolve(sourceUri);

      // Verify the requested path sits inside one of the allowed roots.
      const isAllowed = allowedRoots.some((root) => {
        const resolvedRoot = resolve(root);
        // Ensure the path starts with the root and has a proper boundary
        // (e.g., /foo/bar should not match /foo/baz).
        return resolvedUri === resolvedRoot || resolvedUri.startsWith(resolvedRoot + '/');
      });

      if (!isAllowed) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Transcript source path is outside the allowed roots.',
        );
      }

      try {
        const content = await Bun.file(resolvedUri).text();
        const byteSize = Buffer.byteLength(content, 'utf8');
        const hasher = new Bun.CryptoHasher('sha256');
        hasher.update(content);
        const contentHash = hasher.digest('hex');

        return { content, byteSize, contentHash };
      } catch {
        throw new AppError('NOT_FOUND', 'Transcript source could not be read.');
      }
    },
  };
}
