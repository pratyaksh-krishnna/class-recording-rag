import { createApp } from './app';
import { env } from './config';
import { createPool } from './db/client';
import { log } from './observability/logger';

const pool = createPool(env.DATABASE_URL);
const app = createApp({ pool });

const server = app.listen(env.PORT, () => {
  log().info({ port: env.PORT, nodeEnv: env.NODE_ENV }, 'api listening');
});

async function shutdown(signal: string): Promise<void> {
  log().info({ signal }, 'shutting down');
  server.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
