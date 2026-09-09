import multer from 'multer';
import type { RequestHandler } from 'express';
import { AppError } from '../../errors/AppError';

const ALLOWED_EXTENSIONS = new Set(['.srt', '.vtt']);

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot).toLowerCase();
}

/**
 * Single-field (`file`) memory-storage upload, capped at `maxBytes` (spec
 * §21, §22 `MAX_UPLOAD_BYTES`). Wraps multer's own middleware rather than
 * exporting it directly so both failure modes it can produce become the
 * client-safe `AppError`s the rest of the app expects, instead of an
 * unhandled `MulterError` escaping as a 500. The uploaded filename is never
 * placed in an error message — it is attacker-controlled text.
 */
export function createTranscriptUpload(maxBytes: number): RequestHandler {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_EXTENSIONS.has(extensionOf(file.originalname))) {
        cb(new AppError('UNSUPPORTED_FILE_TYPE', 'Only .srt and .vtt files are accepted.'));
        return;
      }
      cb(null, true);
    },
  }).single('file');

  return (req, res, next) => {
    upload(req, res, (error: unknown) => {
      if (!error) {
        next();
        return;
      }

      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        next(new AppError('FILE_TOO_LARGE', `File exceeds the ${maxBytes}-byte limit.`));
        return;
      }

      next(error);
    });
  };
}
