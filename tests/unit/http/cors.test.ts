import { test, expect, describe } from 'bun:test';
import type { Pool } from 'pg';
import { createApp } from '../../../apps/api/src/app';
import { withTestServer } from '../../helpers/testServer';

const WEB_ORIGIN = 'http://localhost:5173';

/**
 * `createApp` only hands the pool to the health router, which does not touch
 * it until a request arrives at /ready. Every assertion here is about headers,
 * so no database is needed and these stay unit tests.
 */
function appWithCors(allowedOrigins: string[] = [WEB_ORIGIN]) {
  return createApp({ pool: {} as Pool, corsAllowedOrigins: allowedOrigins });
}

function preflight(baseUrl: string, origin: string): Promise<Response> {
  return fetch(`${baseUrl}/api/chat`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-user-id,x-cohort-id',
    },
  });
}

describe('CORS', () => {
  test('answers a preflight from an allowed origin', async () => {
    await withTestServer(appWithCors(), async (baseUrl) => {
      const res = await preflight(baseUrl, WEB_ORIGIN);

      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN);
    });
  });

  test('preflight allows exactly the identity headers the client sends', async () => {
    // requireCohortContext rejects without these, so omitting them from the
    // preflight would fail every browser call while curl kept working.
    await withTestServer(appWithCors(), async (baseUrl) => {
      const allowed = (await preflight(baseUrl, WEB_ORIGIN)).headers.get(
        'access-control-allow-headers',
      );

      expect(allowed).toContain('x-user-id');
      expect(allowed).toContain('x-cohort-id');
      expect(allowed).toContain('content-type');
    });
  });

  test('a disallowed origin gets no allow-origin header, so the browser blocks it', async () => {
    await withTestServer(appWithCors(), async (baseUrl) => {
      const res = await preflight(baseUrl, 'https://evil.example');

      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  test('a real response carries allow-origin and exposes the request id', async () => {
    await withTestServer(appWithCors(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`, { headers: { origin: WEB_ORIGIN } });

      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN);
      expect(res.headers.get('access-control-expose-headers')).toContain('x-request-id');
    });
  });

  test('an error response is still readable cross-origin', async () => {
    // A 404 or 500 without allow-origin reaches the browser as an opaque CORS
    // failure, hiding the real error code the client renders copy from.
    await withTestServer(appWithCors(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/nope`, { headers: { origin: WEB_ORIGIN } });

      expect(res.status).toBe(404);
      expect(res.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN);
    });
  });

  test('varies on Origin even for a disallowed origin, so caches cannot cross origins', async () => {
    await withTestServer(appWithCors(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`, {
        headers: { origin: 'https://evil.example' },
      });

      expect(res.headers.get('vary')).toContain('Origin');
    });
  });

  test('honours every origin in a multi-origin allowlist', async () => {
    const second = 'http://127.0.0.1:5173';
    await withTestServer(appWithCors([WEB_ORIGIN, second]), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`, { headers: { origin: second } });

      expect(res.headers.get('access-control-allow-origin')).toBe(second);
    });
  });

  test('a request with no Origin header is unaffected', async () => {
    // curl and the eval harness call the API without an Origin.
    await withTestServer(appWithCors(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    });
  });

  test('omitting corsAllowedOrigins leaves the API same-origin only', async () => {
    const app = createApp({ pool: {} as Pool });
    await withTestServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`, { headers: { origin: WEB_ORIGIN } });

      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });
});
