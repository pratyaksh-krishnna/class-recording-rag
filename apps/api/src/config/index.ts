import { loadEnv, type Env } from './env.schema';
import { buildRagConfig, type RagConfig } from './rag';

/**
 * The only place in the API runtime that reads process.env — the migration
 * CLI reads DATABASE_URL directly so migrations can run without the full
 * environment.
 * Bun loads .env automatically, so no dotenv import is needed.
 */
export const env: Env = loadEnv(process.env);
export const ragConfig: RagConfig = buildRagConfig(env);

export type { Env, RagConfig };
export { ConfigError } from './env.schema';
