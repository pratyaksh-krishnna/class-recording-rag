import { join } from 'node:path';
import { Router } from 'express';
import type { Database } from '../../db/client';
import { findClassById } from '../../db/repositories/classes.repo';
import { countChunks } from '../../db/repositories/chunks.repo';
import { createRun, findLatestRunByTranscriptId } from '../../db/repositories/ingestionRuns.repo';
import { findTranscriptById, upsertTranscript } from '../../db/repositories/transcripts.repo';
import { AppError } from '../../errors/AppError';
import { createTranscriptUpload } from '../middleware/upload';
import { CreateTranscriptFieldsSchema, TranscriptIdParamSchema } from '../validation/transcripts';

/**
 * The subset of an Inngest client this router needs. Deliberately narrow —
 * not the concrete `Inngest` class — so a test can stub it with a plain
 * object that records calls, with no dev server involved.
 */
export interface InngestEventSender {
  send(event: { name: string; data: unknown }): Promise<unknown>;
}

export interface TranscriptsRouterConfig {
  maxUploadBytes: number;
  chunkingVersion: string;
  embeddingModel: string;
}

export interface TranscriptsRouterDeps {
  db: Database;
  inngest: InngestEventSender;
  /** Root directory transcript bytes are written under, one subfolder per cohort. */
  uploadsDir: string;
  config: TranscriptsRouterConfig;
}

const EXTENSION_BY_FORMAT = { srt: '.srt', vtt: '.vtt' } as const;

function formatFromExtension(fileName: string): 'srt' | 'vtt' {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.srt')) return 'srt';
  if (lower.endsWith('.vtt')) return 'vtt';
  // The upload middleware already rejects anything else, so this only fires
  // if that guard is ever bypassed.
  throw new AppError('UNSUPPORTED_FILE_TYPE', 'Only .srt and .vtt files are accepted.');
}

/**
 * `POST /api/transcripts` and `GET /api/transcripts/:id` (spec §16.2).
 *
 * Both routes are keyed on the transcript — the path segment names that
 * resource. "Status" lives on `ingestion_runs`, not on the transcript row
 * itself, so GET layers on the newest run for the transcript (a transcript
 * can be ingested more than once: a retried upload, a reindex). A transcript
 * that exists but has no run yet is a normal state, not a 404: it reports
 * `pending` with a null `ingestionRunId`.
 */
export function createTranscriptsRouter(deps: TranscriptsRouterDeps): Router {
  const router = Router();
  const upload = createTranscriptUpload(deps.config.maxUploadBytes);

  router.post('/api/transcripts', upload, async (req, res, next) => {
    try {
      if (!req.file) {
        throw new AppError('VALIDATION_ERROR', 'A file is required.', {
          details: { field: 'file' },
        });
      }

      const parsed = CreateTranscriptFieldsSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', 'Invalid transcript upload fields.', {
          details: parsed.error.flatten(),
        });
      }
      const { classId, language } = parsed.data;

      const classRow = await findClassById(deps.db, classId);
      if (!classRow) {
        throw new AppError('NOT_FOUND', 'Class not found.');
      }

      const format = formatFromExtension(req.file.originalname);

      const hasher = new Bun.CryptoHasher('sha256');
      hasher.update(req.file.buffer);
      const contentHash = hasher.digest('hex');

      // Content-addressed path: identical bytes always land on the same file,
      // and the attacker-controlled original filename never touches disk.
      const sourceUri = join(
        deps.uploadsDir,
        classRow.cohortId,
        `${contentHash}${EXTENSION_BY_FORMAT[format]}`,
      );
      await Bun.write(sourceUri, req.file.buffer);

      const transcript = await upsertTranscript(deps.db, {
        cohortId: classRow.cohortId,
        moduleId: classRow.moduleId,
        classId: classRow.id,
        format,
        sourceUri,
        contentHash,
        byteSize: req.file.buffer.byteLength,
        ...(language !== undefined ? { language } : {}),
      });

      const run = await createRun(deps.db, {
        classId: classRow.id,
        transcriptId: transcript.id,
        status: 'pending',
        chunkingVersion: deps.config.chunkingVersion,
        embeddingModel: deps.config.embeddingModel,
      });

      await deps.inngest.send({
        name: 'transcript.ingest.requested',
        data: {
          transcriptId: transcript.id,
          classId: classRow.id,
          cohortId: classRow.cohortId,
          sourceUri,
          requestedBy: req.header('x-user-id') ?? 'api',
        },
      });

      res.status(202).json({
        transcriptId: transcript.id,
        ingestionRunId: run.id,
        status: 'pending',
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/transcripts/:id', async (req, res, next) => {
    try {
      const parsed = TranscriptIdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', 'Invalid transcript id.', {
          details: parsed.error.flatten(),
        });
      }

      const transcript = await findTranscriptById(deps.db, parsed.data.id);
      if (!transcript) {
        throw new AppError('NOT_FOUND', 'Transcript not found.');
      }

      const [run, counts] = await Promise.all([
        findLatestRunByTranscriptId(deps.db, transcript.id),
        countChunks(deps.db, transcript.id),
      ]);

      res.status(200).json({
        transcriptId: transcript.id,
        ingestionRunId: run?.id ?? null,
        // No run yet reads as 'pending': the upload succeeded and ingestion
        // simply hasn't been picked up, not a failure or an unknown state.
        status: run?.status ?? 'pending',
        isActive: transcript.isActive,
        cueCount: run?.cueCount ?? null,
        sentenceCount: run?.sentenceCount ?? null,
        chunkCount: counts,
        errorCode: run?.errorCode ?? null,
        errorMessage: run?.errorMessage ?? null,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
