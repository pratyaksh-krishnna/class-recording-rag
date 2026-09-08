import pino from 'pino';
import { env } from '../config';
import { getRequestContext } from './context';

const baseLogger = pino({
  level: env.LOG_LEVEL,
  base: undefined, // omit pid/hostname noise
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});

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
