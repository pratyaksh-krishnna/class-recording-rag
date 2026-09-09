import { Inngest } from 'inngest';

/**
 * Constructing the client is the only thing that happens at import time, so
 * importing it from a test or a script never opens a connection.
 *
 * Event typing lives on the event definitions in events.ts rather than here:
 * Inngest v4 attaches schemas to each `eventType`, which types both the
 * trigger and every `send` call site.
 */
export const inngest = new Inngest({
  id: 'rag-class-recordings',
  // Inngest v4 assumes cloud mode and rejects every unsigned request with a
  // 500, so `serve()` never registers against the local dev server. Spec §22
  // deliberately leaves INNGEST_SIGNING_KEY unset outside production, which
  // makes "not production" exactly the condition for dev mode. Read from
  // process.env rather than config/env so that importing this client from a
  // test does not drag in full environment validation.
  isDev: process.env.NODE_ENV !== 'production',
});
