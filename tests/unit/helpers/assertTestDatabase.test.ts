import { test, expect, describe, afterEach } from 'bun:test';
import { assertTestDatabase } from '../../helpers/assertTestDatabase';

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe('assertTestDatabase', () => {
  test('accepts a database whose name ends in _test', () => {
    process.env.DATABASE_URL = 'postgres://rag:rag@localhost:5432/rag';
    expect(() =>
      assertTestDatabase('postgres://rag:rag@localhost:5432/rag_test'),
    ).not.toThrow();
  });

  test('accepts a _test database with query parameters', () => {
    expect(() =>
      assertTestDatabase('postgres://rag:rag@localhost:5432/rag_test?sslmode=disable'),
    ).not.toThrow();
  });

  test('refuses a database that is not named _test', () => {
    // The typo this guard exists for: rag_test → rag.
    expect(() => assertTestDatabase('postgres://rag:rag@localhost:5432/rag')).toThrow(
      /non-test database/,
    );
  });

  test('refuses a URL identical to DATABASE_URL even when it ends in _test', () => {
    process.env.DATABASE_URL = 'postgres://rag:rag@localhost:5432/rag_test';
    expect(() =>
      assertTestDatabase('postgres://rag:rag@localhost:5432/rag_test'),
    ).toThrow(/non-test database/);
  });

  test('refuses a production-looking URL', () => {
    expect(() => assertTestDatabase('postgres://user:pw@prod.example.com:5432/app')).toThrow();
  });
});
