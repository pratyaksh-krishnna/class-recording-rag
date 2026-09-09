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
});
