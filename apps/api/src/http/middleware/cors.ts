import type { RequestHandler } from 'express';

/** The identity headers from requireCohortContext, plus the JSON content type. */
const ALLOWED_HEADERS = 'content-type, x-user-id, x-cohort-id';
const ALLOWED_METHODS = 'GET, POST, OPTIONS';

/**
 * The web app is served from a different origin than the API (5173 vs 3000),
 * so every browser call is cross-origin. Without these headers the preflight
 * has no `Access-Control-Allow-Origin` and the browser drops the request
 * before it is ever sent — which surfaces to the user as a generic server
 * error even though the server was never reached.
 *
 * Origins are allowlisted rather than reflected back or answered with `*`:
 * spec §21 makes identity a pair of spoofable headers, so anything that can
 * reach this API can read any cohort. A wildcard would extend that reach to
 * every page the user has open.
 */
export function createCorsMiddleware(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);

  return (req, res, next) => {
    const origin = req.header('origin');

    // Set on every response, including disallowed origins: the response body
    // varies by Origin, and a shared cache that missed this could hand one
    // origin's allow-headers to another.
    res.vary('Origin');

    if (origin !== undefined && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      // Lets the client surface the requestId from a failed response, which is
      // the only handle for correlating a browser error with a server log.
      res.setHeader('Access-Control-Expose-Headers', 'x-request-id');
    }

    // Preflights terminate here rather than falling through to the routers,
    // where OPTIONS would be answered by Express's default handler with no
    // CORS headers at all. A disallowed origin still gets a 204, but without
    // the allow-origin header above, so the browser blocks it.
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }

    next();
  };
}
