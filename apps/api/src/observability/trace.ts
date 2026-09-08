import { log } from './logger';

export interface SpanResult<T> {
  result: T;
  durationMs: number;
}

/**
 * Times an async stage and logs its duration. Every pipeline stage named in
 * spec §20 is wrapped in this, which is what makes retrieval and generation
 * latency observable without scattering Date.now() through the orchestrator.
 */
export async function span<T>(
  name: string,
  fn: () => Promise<T>,
  fields: Record<string, unknown> = {},
): Promise<SpanResult<T>> {
  const startedAt = performance.now();
  try {
    const result = await fn();
    const durationMs = Math.round(performance.now() - startedAt);
    log().info({ span: name, durationMs, ...fields }, 'span completed');
    return { result, durationMs };
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    log().error(
      { span: name, durationMs, errMessage: error instanceof Error ? error.message : String(error) },
      'span failed',
    );
    throw error;
  }
}
