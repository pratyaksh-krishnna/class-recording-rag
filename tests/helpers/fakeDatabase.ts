import type { Database } from '../../apps/api/src/db/client';

type Row = Record<string, unknown>;

function isSqlNode(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reconstructs enough of a drizzle `sql` template's literal text to route on
 * (e.g. distinguishing "ts_rank_cd" from "embedding <=>" from "array_position")
 * without a real SQL engine — drizzle's `SQL` objects expose their literal
 * pieces as `StringChunk`s inside `.queryChunks`, which this just concatenates.
 */
export function sqlMarkerText(node: unknown): string {
  if (!isSqlNode(node)) return '';
  const queryChunks = node.queryChunks;
  if (Array.isArray(queryChunks)) return queryChunks.map(sqlMarkerText).join('');
  const value = node.value;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return (value as string[]).join('');
  return '';
}

/**
 * Extracts `{dbColumnName: value}` pairs out of a drizzle `eq()` /
 * `and(eq(), eq(), ...)` condition tree, by walking its chunks in order and
 * pairing each `Param` with the most recently seen column reference before
 * it. Every WHERE clause this codebase's repo functions issue is a flat
 * equality (or AND of equalities), so this is enough — it is not a SQL
 * interpreter and isn't meant to become one.
 */
export function extractConditions(node: unknown): Row {
  const result: Row = {};
  let lastColumnName: string | undefined;

  function walk(n: unknown): void {
    if (!isSqlNode(n)) return;
    const queryChunks = n.queryChunks;
    if (Array.isArray(queryChunks)) {
      for (const chunk of queryChunks) walk(chunk);
      return;
    }
    if (n.constructor?.name === 'Param') {
      if (lastColumnName !== undefined) result[lastColumnName] = n.value;
      return;
    }
    if (typeof n.name === 'string' && 'table' in n) {
      lastColumnName = n.name;
    }
  }

  walk(node);
  return result;
}

function columnMap(table: object): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [key, col] of Object.entries(table as Record<string, unknown>)) {
    if (col && typeof col === 'object' && typeof (col as Row).name === 'string') {
      map[key] = (col as Row).name as string;
    }
  }
  return map;
}

function project(row: Row, cols: Record<string, { name: string }>): Row {
  const out: Row = {};
  for (const [outKey, colRef] of Object.entries(cols)) out[outKey] = row[colRef.name];
  return out;
}

export interface ExecuteResult {
  rows: Row[];
  rowCount?: number;
}

export interface ExecuteRoute {
  /** Matched via .includes() against the compiled SQL text, checked in order. */
  marker: string;
  handler: () => ExecuteResult | Promise<ExecuteResult>;
}

export interface FakeDatabaseOptions {
  executeRoutes?: ExecuteRoute[];
}

export interface FakeDatabase {
  db: Database;
  rowsOf: (table: object) => Row[];
}

/**
 * A minimal in-memory stand-in for drizzle's `NodePgDatabase`, covering just
 * the chain shapes this codebase's repo functions use:
 *
 *   insert(table).values(row | row[]).returning(cols)?
 *   select(cols).from(table).where(cond).orderBy(...)?.limit(n)?
 *   update(table).set(patch).where(cond)
 *   transaction(fn)
 *   execute(sqlTemplate)   -- routed by executeRoutes, for raw-SQL repo functions
 *
 * WHERE conditions are interpreted structurally (see extractConditions)
 * instead of by re-implementing SQL — sufficient for the equality-only WHERE
 * clauses every insert/select/update repo function in this codebase issues.
 * Raw-SQL callers (chunks.repo, the vector/keyword retrievers) are routed by
 * a marker substring in the compiled query text rather than executed for
 * real, since replicating pgvector/tsvector semantics in memory would test
 * nothing that tests/integration/rag/retrieval.test.ts doesn't already cover
 * against real Postgres.
 *
 * Deliberately NOT a `mock.module()` replacement of the real repo/retrieval
 * modules: bun:test's module mocks are process-global and persist across
 * test files with no working restore, so mocking `conversations.repo.ts`,
 * `chunks.repo.ts`, or `retrieval/hybrid.ts` here would corrupt the OTHER
 * test files that exercise those same modules for real against Postgres.
 * This fake instead sits one layer lower, behind the real `db: Database`
 * parameter, so orchestrator.ts calls the REAL repo/retrieval functions
 * end-to-end — only the Postgres connection itself is faked.
 */
export function createFakeDatabase(options: FakeDatabaseOptions = {}): FakeDatabase {
  const stores = new Map<object, Row[]>();
  let counter = 0;

  function rowsOf(table: object): Row[] {
    let rows = stores.get(table);
    if (!rows) {
      rows = [];
      stores.set(table, rows);
    }
    return rows;
  }

  function nextId(): string {
    counter += 1;
    return `fake-id-${counter}`;
  }

  const fakeDb = {
    insert(table: object) {
      return {
        values(input: Row | Row[]) {
          const cmap = columnMap(table);
          const inputs = Array.isArray(input) ? input : [input];
          const inserted = inputs.map((row) => {
            const dbRow: Row = {};
            for (const [jsKey, value] of Object.entries(row)) dbRow[cmap[jsKey] ?? jsKey] = value;
            if (dbRow.id === undefined) dbRow.id = nextId();
            if (dbRow.created_at === undefined) dbRow.created_at = new Date();
            if (dbRow.updated_at === undefined) dbRow.updated_at = new Date();
            rowsOf(table).push(dbRow);
            return dbRow;
          });

          // Awaitable directly (bulk citation inserts never chain .returning())
          // AND chainable with .returning() (message/conversation inserts do).
          return Object.assign(Promise.resolve(undefined), {
            returning(cols: Record<string, { name: string }>) {
              return Promise.resolve(inserted.map((row) => project(row, cols)));
            },
          });
        },
      };
    },

    select(cols: Record<string, { name: string }>) {
      return {
        from(table: object) {
          return {
            where(cond: unknown) {
              const conds = extractConditions(cond);
              const matching = (): Row[] =>
                rowsOf(table)
                  .filter((row) => Object.entries(conds).every(([k, v]) => row[k] === v))
                  .map((row) => project(row, cols));

              const chain = {
                orderBy: () => chain,
                limit: () => chain,
                then: (resolve: (v: Row[]) => void, reject?: (e: unknown) => void) => {
                  try {
                    resolve(matching());
                  } catch (error) {
                    reject?.(error);
                  }
                },
              };
              return chain;
            },
          };
        },
      };
    },

    update(table: object) {
      return {
        set(patch: Row) {
          const cmap = columnMap(table);
          return {
            where(cond: unknown) {
              const conds = extractConditions(cond);
              return Promise.resolve().then(() => {
                for (const row of rowsOf(table)) {
                  if (Object.entries(conds).every(([k, v]) => row[k] === v)) {
                    for (const [jsKey, value] of Object.entries(patch)) row[cmap[jsKey] ?? jsKey] = value;
                  }
                }
              });
            },
          };
        },
      };
    },

    async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
      return fn(fakeDb as unknown as Database);
    },

    async execute(query: unknown): Promise<ExecuteResult> {
      const text = sqlMarkerText(query);
      for (const route of options.executeRoutes ?? []) {
        if (text.includes(route.marker)) return route.handler();
      }
      return { rows: [], rowCount: 0 };
    },
  };

  return { db: fakeDb as unknown as Database, rowsOf };
}
