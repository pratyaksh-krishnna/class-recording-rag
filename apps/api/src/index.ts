import { createApp } from './app';
import { env } from './config';
import { createPool } from './db/client';
import { log } from './observability/logger';

const pool = createPool(env.DATABASE_URL, env.DB_POOL_MAX);
const app = createApp({ pool });

const server = app.listen(env.PORT, () => {
  log().info({ port: env.PORT, nodeEnv: env.NODE_ENV }, 'api listening');
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log().info({ signal }, 'shutting down');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
