import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, isAppError, toErrorBody } from '../../errors/AppError';
import { log } from '../../observability/logger';

/** Terminal 404 for unmatched routes. Registered after every other route. */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError('NOT_FOUND', 'Route not found.'));
};

/**
 * The single place an error becomes an HTTP response.
 * Internal detail is logged; only client-safe fields are serialized.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const requestId = req.requestId ?? 'unknown';
  const { status, body, expected } = toErrorBody(error, requestId);

  const logPayload = {
    status,
    code: body.error.code,
    method: req.method,
    path: req.path,
    ...(expected
      ? { reason: (error instanceof Error ? error.message : String(error)) || 'unknown' }
      : { err: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }),
  };

  if (status >= 500 && !expected) {
    log().error(logPayload, 'unhandled error');
  } else if (status >= 500) {
    log().error(logPayload, 'request failed');
  } else if (status === 404) {
    log().info(logPayload, 'request rejected');
  } else {
    log().warn(logPayload, 'request rejected');
  }

  res.status(status).json(body);
};
