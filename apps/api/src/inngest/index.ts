import type { Database } from '../db/client';
import type { PipelineDeps } from '../ingestion/pipeline';
import { createIngestTranscriptFunction } from './functions/ingestTranscript';
import { createReindexTranscriptFunction } from './functions/reindexTranscript';

// Re-export event definitions and client for convenience
export * from './events';
export { inngest } from './client';

/**
 * Constructs and returns both Inngest functions, ready to be mounted on a
 * serve handler. Each function has its pipeline deps and concurrency limits
 * pre-configured at boot.
 */
export function createInngestFunctions(deps: {
  db: Database;
  pipeline: PipelineDeps;
  ingestConcurrency: number;
}) {
  return [
    createIngestTranscriptFunction({
      db: deps.db,
      pipeline: deps.pipeline,
      ingestConcurrency: deps.ingestConcurrency,
    }),
    createReindexTranscriptFunction({
      db: deps.db,
      pipeline: deps.pipeline,
      ingestConcurrency: deps.ingestConcurrency,
    }),
  ];
}
