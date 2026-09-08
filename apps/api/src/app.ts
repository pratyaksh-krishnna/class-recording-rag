import express, { type Express } from 'express';
import type { Pool } from 'pg';
import { requestContextMiddleware } from './http/middleware/requestContext';
import { errorHandler, notFoundHandler } from './http/middleware/errorHandler';
import { createHealthRouter } from './http/routes/health.routes';

export interface AppDependencies {
  pool: Pool;
}

/**
 * Assembles the HTTP layer. Dependencies are injected rather than imported so
 * tests can supply their own pool, and so no module-level connection is opened
 * as a side effect of importing this file.
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(requestContextMiddleware);

  app.use(createHealthRouter(deps.pool));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
