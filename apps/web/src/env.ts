/**
 * Client-visible configuration. Bun inlines only `PUBLIC_*` at bundle time
 * (spec §21); these identity values are the spoofable V1 placeholders sent as
 * `x-user-id` / `x-cohort-id` on every API request.
 */

function requireEnv(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. Set it in .env (see .env.example).`,
    );
  }
  return value;
}

export const apiBaseUrl: string = process.env.PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

export const cohortId: string = requireEnv('PUBLIC_COHORT_ID', process.env.PUBLIC_COHORT_ID);

export const userId: string = process.env.PUBLIC_USER_ID ?? 'local-student';
