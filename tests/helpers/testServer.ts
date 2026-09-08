import type { Express } from 'express';
import type { AddressInfo } from 'node:net';

/**
 * Starts `app` on an ephemeral port, runs `fn` against its base URL, and
 * always closes the server — including when `fn` throws. Used by every HTTP
 * test so no test has to manage ports or leak a listener.
 */
export async function withTestServer<T>(
  app: Express,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = app.listen(0);

  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error('test server did not bind to a port');

  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
