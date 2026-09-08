/**
 * Refuses to let a destructive integration test run anywhere but a test
 * database.
 *
 * The integration suite runs `DROP SCHEMA public CASCADE` and
 * `TRUNCATE ... CASCADE` against whatever TEST_DATABASE_URL names, and the two
 * URLs in .env.example differ by five characters on the same host. One typo
 * would otherwise destroy the development database on the next `bun test`.
 *
 * The rule is deliberately blunt: the database name must end in `_test`, and
 * it must not be the very URL the application uses.
 */
export function assertTestDatabase(url: string): void {
  if (!/_test(\?|$)/.test(url) || url === process.env.DATABASE_URL) {
    throw new Error('Refusing to run destructive tests against a non-test database');
  }
}
