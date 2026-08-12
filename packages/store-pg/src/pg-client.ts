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
/** Query surface shared by pooled clients and transaction-scoped clients. */
export type QuerySql = postgres.Sql | postgres.TransactionSql;

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
    CREATE TABLE IF NOT EXISTS nexora_suspended_turns (
      pending_id TEXT PRIMARY KEY,
      data JSONB NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS nexora_effect_leases (
      run_id     TEXT PRIMARY KEY,
      owner      TEXT NOT NULL,
      token      BIGINT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS nexora_effect_steps (
      run_id     TEXT NOT NULL,
      effect_key TEXT NOT NULL,
      status     TEXT NOT NULL CHECK (status IN ('running', 'done')),
      value      JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (run_id, effect_key)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS nexora_runtime_inputs (
      sequence    BIGSERIAL PRIMARY KEY,
      run_id      TEXT NOT NULL,
      input_id    TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'admitted', 'discarded')),
      value       JSONB NOT NULL,
      admitted_at TIMESTAMPTZ,
      UNIQUE (run_id, input_id)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_nexora_runtime_inputs_run_sequence
    ON nexora_runtime_inputs (run_id, sequence)
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

  await sql`
    CREATE TABLE IF NOT EXISTS nexora_transcript_entry (
      seq             BIGSERIAL PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      uuid            TEXT NOT NULL,
      channel         TEXT,
      type            TEXT NOT NULL,
      ts              TIMESTAMPTZ NOT NULL,
      entry           JSONB NOT NULL
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_nexora_transcript_entry_conv
      ON nexora_transcript_entry (conversation_id, seq)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_nexora_transcript_entry_ts
      ON nexora_transcript_entry (ts)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_nexora_transcript_entry_channel
      ON nexora_transcript_entry (channel)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS nexora_transcript_attachment (
      conversation_id TEXT NOT NULL,
      ref             TEXT NOT NULL,
      media_type      TEXT NOT NULL,
      size            BIGINT NOT NULL,
      name            TEXT,
      data            BYTEA NOT NULL,
      PRIMARY KEY (conversation_id, ref)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS nexora_artifacts (
      ref         TEXT PRIMARY KEY,
      scope       TEXT NOT NULL,
      name        TEXT NOT NULL,
      media_type  TEXT NOT NULL,
      size        BIGINT NOT NULL,
      created_at  BIGINT NOT NULL,
      expires_at  BIGINT,
      meta        JSONB,
      data        BYTEA NOT NULL
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_nexora_artifacts_scope ON nexora_artifacts(scope)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_nexora_artifacts_expires ON nexora_artifacts(expires_at)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS nexora_workspace_state (
      conversation_id TEXT PRIMARY KEY,
      data            JSONB NOT NULL
    )
  `;
}
