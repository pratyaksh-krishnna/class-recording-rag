import express, { type Express } from 'express';
import { serve } from 'inngest/express';
import type { Pool } from 'pg';
import type { Database } from './db/client';
import { requestContextMiddleware } from './http/middleware/requestContext';
import { errorHandler, notFoundHandler } from './http/middleware/errorHandler';
import { createHealthRouter } from './http/routes/health.routes';
import { createCatalogRouter } from './http/routes/catalog.routes';
import {
  createTranscriptsRouter,
  type InngestEventSender,
  type TranscriptsRouterConfig,
} from './http/routes/transcripts.routes';

/**
 * The narrow slice of a real Inngest client `serve()` needs. Kept separate
 * from `InngestEventSender` (which only needs `.send`) because the two are
 * used for different things: emitting an event from a route body, versus
 * exposing every registered function to the Inngest dev server / cloud for
 * invocation. A test that only exercises the HTTP routes never has to
 * construct one of these.
 */
export interface InngestServeDeps {
  client: Parameters<typeof serve>[0]['client'];
  functions: Parameters<typeof serve>[0]['functions'];
}

export interface AppDependencies {
  pool: Pool;
  /** Drizzle handle. Required by every route beyond health/readiness. */
  db?: Database;
  /** Used by POST /api/transcripts to emit `transcript.ingest.requested`. */
  inngest?: InngestEventSender;
  inngestServe?: InngestServeDeps;
  /** Root directory transcript uploads are written under. */
  uploadsDir?: string;
  transcriptsConfig?: TranscriptsRouterConfig;
}

/**
 * Assembles the HTTP layer. Dependencies are injected rather than imported so
 * tests can supply their own pool, and so no module-level connection is opened
 * as a side effect of importing this file.
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');
  // requestContext runs first so that body-parser failures (malformed or
  // oversized JSON) are still reported with a real requestId and x-request-id
  // header, rather than the 'unknown' placeholder.
  app.use(requestContextMiddleware);
  app.use(express.json({ limit: '1mb' }));

  app.use(createHealthRouter(deps.pool));

  // Each router's collaborators are optional constructor arguments, never
  // module-level singletons, so a caller that only needs health checks (e.g.
  // the existing test harness) can still build an app with just a pool. A
  // router mounts only once every dependency it needs is actually present.
  if (deps.db && deps.inngest && deps.uploadsDir && deps.transcriptsConfig) {
    app.use(
      createTranscriptsRouter({
        db: deps.db,
        inngest: deps.inngest,
        uploadsDir: deps.uploadsDir,
        config: deps.transcriptsConfig,
      }),
    );
  }

  if (deps.db) {
    app.use(createCatalogRouter(deps.db));
  }

  if (deps.inngestServe) {
    app.use('/api/inngest', serve(deps.inngestServe));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
