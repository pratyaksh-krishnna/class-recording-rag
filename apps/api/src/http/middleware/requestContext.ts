import type { RequestHandler } from 'express';
import { runWithRequestContext } from '../../observability/context';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

/**
 * Assigns a request id and enters the AsyncLocalStorage context so every log
 * line emitted while handling this request carries it (spec §20).
 * An inbound x-request-id is honoured so a caller can correlate across hops.
 */
export const requestContextMiddleware: RequestHandler = (req, res, next) => {
  const inbound = req.header('x-request-id');
  const requestId = inbound && inbound.length <= 128 ? inbound : crypto.randomUUID();

  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  runWithRequestContext({ requestId }, () => {
    next();
  });
};
