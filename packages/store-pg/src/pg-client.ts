/**
 * PostgreSQL client wrapper — thin abstraction over postgres.js.
 *
 * Handles connection pooling, schema initialization, and provides
 * a typed query interface for all store implementations.
 */

import postgres from 'postgres';

export interface PgOptions {
  /** PostgreSQL connection URL (e.g., postgres://user:pass@host:5432/db) */
  connectionString: string;
  /** Max pool connections. Default: 10 */
  maxConnections?: number;
  /** Auto-create tables on connect. Default: true */
  autoMigrate?: boolean;
}

export type Sql = postgres.Sql;

export async function createPgClient(options: PgOptions): Promise<{
  sql: Sql;
  close: () => Promise<void>;
}> {
  const sql = postgres(options.connectionString, {
    max: options.maxConnections ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
  });

  if (options.autoMigrate !== false) {
    await migrate(sql);
  }

  return {
    sql,
    close: () => sql.end(),
  };
}

async function migrate(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS nexora_conversations (
      id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (conversation_id, id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS nexora_compaction_summaries (
      conversation_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS nexora_knowledge (
      namespace TEXT NOT NULL,
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (namespace, topic)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS nexora_audit (
      id SERIAL PRIMARY KEY,
      namespace TEXT NOT NULL,
      entry JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_audit_namespace ON nexora_audit(namespace)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS nexora_schedules (
      namespace TEXT NOT NULL,
      job_id TEXT NOT NULL,
      data JSONB NOT NULL,
      PRIMARY KEY (namespace, job_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS nexora_context (
      namespace TEXT NOT NULL,
      date TEXT NOT NULL,
      data JSONB NOT NULL,
      PRIMARY KEY (namespace, date)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS nexora_tool_context (
      id SERIAL PRIMARY KEY,
      scope TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      record JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_tool_context_scope_turn
    ON nexora_tool_context(scope, turn_id)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS nexora_session_tree (
      id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      parent_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (conversation_id, id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS nexora_session_leaf (
      conversation_id TEXT PRIMARY KEY,
      leaf_id TEXT NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS nexora_budget (
      scope TEXT PRIMARY KEY,
      total_spent DOUBLE PRECISION DEFAULT 0,
      budget_limit DOUBLE PRECISION,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS nexora_rate_limit (
      tenant_id TEXT NOT NULL,
      window_start BIGINT NOT NULL,
      request_count INT DEFAULT 1,
      PRIMARY KEY (tenant_id, window_start)
    )
  `;
}
