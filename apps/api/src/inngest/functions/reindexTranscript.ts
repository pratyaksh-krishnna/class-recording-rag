import { safeErrorMessage, toInngestError } from '../errors';
import { NonRetriableError } from 'inngest';
import type { Context } from 'inngest';
import type { Database } from '../../db/client';
import type { PipelineDeps } from '../../ingestion/pipeline';
import {
  PermanentIngestError,
  parseAndChunkStep,
  persistChunksStep,
  embedPendingStep,
} from '../../ingestion/pipeline';
import { findClassById } from '../../db/repositories/classes.repo';
import { findModuleById } from '../../db/repositories/modules.repo';
import { findCohortById } from '../../db/repositories/cohorts.repo';
import { createRun, updateRunStatus } from '../../db/repositories/ingestionRuns.repo';
import { inngest } from '../client';
import { transcriptReindexRequested, type TranscriptReindexRequested } from '../events';

export function createReindexTranscriptFunction(deps: {
  db: Database;
  pipeline: PipelineDeps;
  ingestConcurrency: number;
}): ReturnType<typeof inngest.createFunction> {
  return inngest.createFunction(
    {
      id: 'reindex-transcript',
      retries: 3,
      concurrency: { limit: deps.ingestConcurrency },
      idempotency: 'event.data.transcriptId',
      triggers: [transcriptReindexRequested],
    },
    async ({ event, step, logger }: any) => {
      // Re-validate the payload at the worker boundary
      const data = await step.run('validate-event', async () => {
        try {
          return transcriptReindexRequested.schema.parse(event.data);
        } catch (err) {
          throw new PermanentIngestError(
            'INVALID_EVENT',
            'Event payload failed validation; event structure may have changed',
          );
        }
      });

      const { transcriptId, chunkingVersion, embeddingModel } = data;

      // Fetch the transcript
      const transcriptRow = await step.run('fetch-transcript', async () => {
        const t = await deps.pipeline.repos.findTranscriptById(transcriptId);
        if (!t) {
          throw new PermanentIngestError('TRANSCRIPT_NOT_FOUND', 'Transcript record not found');
        }
        return t;
      });

      // Fetch class, module, and cohort to get slugs
      const classRow = await step.run('fetch-class', async () => {
        const cls = await findClassById(deps.db, transcriptRow.classId);
        if (!cls) {
          throw new PermanentIngestError('CLASS_NOT_FOUND', 'Class record not found');
        }
        return cls;
      });

      const moduleRow = await step.run('fetch-module', async () => {
        const mod = await findModuleById(deps.db, classRow.moduleId);
        if (!mod) {
          throw new PermanentIngestError('MODULE_NOT_FOUND', 'Module record not found');
        }
        return mod;
      });

      const cohortRow = await step.run('fetch-cohort', async () => {
        const coh = await findCohortById(deps.db, transcriptRow.cohortId);
        if (!coh) {
          throw new PermanentIngestError('COHORT_NOT_FOUND', 'Cohort record not found');
        }
        return coh;
      });

      // Create an ingestion run for reindexing
      const run = await step.run('create-run', async () => {
        return createRun(deps.db, {
          classId: transcriptRow.classId,
          transcriptId,
          eventId: event.id,
          status: 'pending',
          chunkingVersion,
          embeddingModel,
        });
      });

      const runId = run.id;

      try {
        // Re-parse and re-chunk the transcript
        // Note: we need to load the content from the source again
        const loadResult = await step.run('load-transcript', async () => {
          await updateRunStatus(deps.db, runId, 'parsing');
          return deps.pipeline.source.read(transcriptRow.sourceUri);
        });

        // Parse cues and chunk sentences with new versions
        const parseResult = await step.run('parse', async () => {
          return parseAndChunkStep(deps.pipeline, {
            transcriptId,
            content: loadResult.content,
            fileName: transcriptRow.sourceUri.split('/').pop() ?? transcriptRow.sourceUri,
            cohortSlug: cohortRow.slug,
            moduleSlug: moduleRow.slug,
            classSlug: classRow.slug,
            contentHash: transcriptRow.contentHash,
          });
        });

        // Persist chunks with new version
        const persistResult = await step.run('persist-chunks', async () => {
          return persistChunksStep(deps.pipeline, {
            chunks: parseResult.chunks,
            transcriptId,
            cohortId: transcriptRow.cohortId,
            moduleId: transcriptRow.moduleId,
            classId: transcriptRow.classId,
          });
        });

        // Embed pending chunks (only new chunks with null embeddings)
        const embedResult = await step.run('embed', async () => {
          await updateRunStatus(deps.db, runId, 'embedding');
          return embedPendingStep(deps.pipeline, { transcriptId });
        });

        // Finalize the run
        await step.run('finalize', async () => {
          await updateRunStatus(deps.db, runId, 'completed', {
            cueCount: parseResult.cueCount,
            sentenceCount: parseResult.sentenceCount,
            chunkCount: persistResult.inserted,
            embeddedCount: embedResult.embedded,
          });
        });

        logger.info(
          {
            transcriptId,
            classId: transcriptRow.classId,
            chunkingVersion,
            embeddingModel,
            chunks: persistResult.inserted,
            embedded: embedResult.embedded,
          },
          'Reindex completed successfully',
        );
      } catch (error) {
        // Handle errors and update run status
        const inngestError = toInngestError(error);
        const errorDetails = safeErrorMessage(error, 'reindexing');

        await step.run('handle-error', async () => {
          await updateRunStatus(deps.db, runId, 'failed', {
            errorCode: errorDetails.code,
            errorMessage: errorDetails.message,
          });
        });

        logger.error(
          {
            transcriptId,
            classId: transcriptRow.classId,
            code: errorDetails.code,
            message: errorDetails.message,
          },
          'Reindex failed',
        );

        throw inngestError;
      }
    },
  );
}
