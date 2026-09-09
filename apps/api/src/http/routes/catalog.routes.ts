import { Router } from 'express';
import { z } from 'zod';
import type { CatalogResponse } from '@rag/shared';
import type { Database } from '../../db/client';
import { findCohortById } from '../../db/repositories/cohorts.repo';
import { listModulesWithClasses } from '../../db/repositories/modules.repo';
import { AppError } from '../../errors/AppError';

const CohortIdParamSchema = z.object({ cohortId: z.string().uuid('cohortId must be a uuid') });

/**
 * `GET /api/cohorts/:cohortId/catalog` (spec §16.2) — modules and classes for
 * the upload/browse UI. Never handed to the query planner; that pipeline only
 * ever sees retrieved chunks.
 */
export function createCatalogRouter(db: Database): Router {
  const router = Router();

  router.get('/api/cohorts/:cohortId/catalog', async (req, res, next) => {
    try {
      const parsed = CohortIdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', 'Invalid cohort id.', {
          details: parsed.error.flatten(),
        });
      }
      const { cohortId } = parsed.data;

      const cohort = await findCohortById(db, cohortId);
      if (!cohort) {
        throw new AppError('COHORT_NOT_FOUND', 'Cohort not found.');
      }

      const modules = await listModulesWithClasses(db, cohortId);
      // cohortName is here so the UI masthead names the cohort from the
      // database rather than from a client-side constant that could drift.
      const body: CatalogResponse = {
        cohortId: cohort.id,
        cohortSlug: cohort.slug,
        cohortName: cohort.name,
        modules,
      };
      res.status(200).json(body);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
