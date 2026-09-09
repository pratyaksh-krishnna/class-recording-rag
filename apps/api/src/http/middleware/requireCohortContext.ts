import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors/AppError';

declare global {
  namespace Express {
    interface Request {
      userId: string;
      cohortId: string;
    }
  }
}

const HeadersSchema = z.object({
  userId: z.string().min(1, 'x-user-id header is required'),
  cohortId: z.string().uuid('x-cohort-id header must be a uuid'),
});

/**
 * V1's identity boundary (spec §21): `x-user-id`/`x-cohort-id` are
 * unauthenticated and trivially spoofable — this is the single place real
 * authentication will replace them. Every route mounted after this middleware
 * trusts `req.userId`/`req.cohortId` without re-checking.
 */
export const requireCohortContext: RequestHandler = (req, _res, next) => {
  const parsed = HeadersSchema.safeParse({
    userId: req.header('x-user-id'),
    cohortId: req.header('x-cohort-id'),
  });

  if (!parsed.success) {
    next(
      new AppError('VALIDATION_ERROR', 'x-user-id and x-cohort-id headers are required.', {
        details: parsed.error.flatten(),
      }),
    );
    return;
  }

  req.userId = parsed.data.userId;
  req.cohortId = parsed.data.cohortId;
  next();
};
