/**
 * Helper to cast objects for postgres.js sql.json() parameter.
 * postgres.js expects JSONValue but our contract types are unknown-shaped.
 */

import type { QuerySql, Sql } from './pg-client.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function jsonParam(sql: QuerySql, value: unknown): ReturnType<Sql['json']> {
  return sql.json(value as any);
}
