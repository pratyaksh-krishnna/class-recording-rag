import pino from 'pino';
import { getRequestContext } from './context';

// Read process.env directly rather than importing the validated config.
// A logging module must not be the thing that enforces an OpenAI key exists:
// importing it transitively made the whole app un-importable without a full
// environment. Fail-fast still lives in index.ts, which imports ./config at boot.
const level = process.env.LOG_LEVEL ?? 'info';
const usePretty = process.env.NODE_ENV === 'development';

function buildLogger(): pino.Logger {
  if (usePretty) {
    try {
      return pino({
        level,
        base: undefined,
        transport: { target: 'pino-pretty', options: { colorize: true } },
      });
    } catch {
      // pino-pretty is a devDependency; fall back to plain JSON if absent.
    }
  }
  return pino({ level, base: undefined });
}

const baseLogger = buildLogger();

/**
 * Returns a logger bound to the active request context when there is one.
 *
 * Content policy (spec §20): log lengths, counts, and identifiers at info.
 * Question text, answer text, and chunk text belong at debug and nowhere else.
 */
export function log(): pino.Logger {
  const context = getRequestContext();
  return context ? baseLogger.child(context) : baseLogger;
}

export { baseLogger };
