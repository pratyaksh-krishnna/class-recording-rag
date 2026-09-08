import type { LLMProvider, LLMRequest, LLMResult } from './provider';

const SCRIPTED_ERROR = Symbol('scriptedError');

interface ScriptedErrorEntry {
  [SCRIPTED_ERROR]: true;
  error: unknown;
}

/** Wrap an error so a script entry can force a call to reject instead of resolve. */
export function scriptedError(error: unknown): ScriptedErrorEntry {
  return { [SCRIPTED_ERROR]: true, error };
}

function isScriptedError(value: unknown): value is ScriptedErrorEntry {
  return typeof value === 'object' && value !== null && SCRIPTED_ERROR in value;
}

/** One queue per json_schema name; each entry is a canned value or a scriptedError(). */
export type LLMScript = Record<string, unknown[]>;

export interface RecordedCall {
  schemaName: string;
  system: string;
  user: string;
}

export interface ScriptedLLMProvider extends LLMProvider {
  /** schemaName + prompts for every call made, in call order — e.g. to assert a step was skipped. */
  readonly calls: RecordedCall[];
}

/**
 * Drives end-to-end tests deterministically with zero network: each
 * schemaName has its own queue of canned outputs, consumed in order. An
 * exhausted queue throws immediately rather than hanging or returning
 * undefined, so a missing script entry fails the test at the call site.
 */
export function createScriptedLLMProvider(script: LLMScript, model = 'scripted-mock'): ScriptedLLMProvider {
  const queues = new Map<string, unknown[]>(Object.entries(script).map(([key, values]) => [key, [...values]]));
  const calls: RecordedCall[] = [];

  return {
    model,
    calls,
    async complete<T>(request: LLMRequest<T>): Promise<LLMResult<T>> {
      calls.push({ schemaName: request.schemaName, system: request.system, user: request.user });

      const queue = queues.get(request.schemaName);
      if (queue === undefined || queue.length === 0) {
        throw new Error(
          `createScriptedLLMProvider: no scripted value left for schema "${request.schemaName}" ` +
            `(${queue === undefined ? 'no queue was scripted for it' : 'its queue is exhausted'})`,
        );
      }

      const next = queue.shift();
      if (isScriptedError(next)) throw next.error;
      return { value: next as T };
    },
  };
}
