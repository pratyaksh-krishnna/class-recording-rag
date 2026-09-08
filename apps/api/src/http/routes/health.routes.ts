import { Router } from 'express';
import type { Pool } from 'pg';
import { log } from '../../observability/logger';

export function createHealthRouter(pool: Pool): Router {
  const router = Router();

  /** Liveness. Deliberately does not touch the database. */
  router.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  /**
   * Readiness. Confirms both that the database answers and that pgvector is
   * installed, because a database without the extension cannot serve a single
   * retrieval query.
   */
  router.get('/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      const { rows } = await pool.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname = 'vector'",
      );
      const pgvector = rows.length > 0;

      if (!pgvector) {
        res.status(503).json({ status: 'not-ready', database: true, pgvector: false });
        return;
      }

      res.status(200).json({ status: 'ready', database: true, pgvector: true });
    } catch (error) {
      log().error(
        { err: error instanceof Error ? error.message : String(error) },
        'readiness check failed',
      );
      res.status(503).json({ status: 'not-ready', database: false, pgvector: false });
    }
  });

  return router;
}
