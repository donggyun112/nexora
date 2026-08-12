import type {
  DescribableStore,
  EffectLedger,
  EffectRecord,
  RuntimeInputQueue,
  RuntimeInputRecord,
  StoreBackendInfo,
} from '@dongkseo/contracts';
import { EffectWriteFencedError } from '@dongkseo/contracts';
import type { Sql } from './pg-client.js';
import { jsonParam } from './helpers.js';

/** PostgreSQL EffectLedger with transactional intent writes and fenced leases. */
export class EffectLedgerPg implements EffectLedger, RuntimeInputQueue, DescribableStore {
  constructor(private readonly sql: Sql) {}

  describeBackend(): StoreBackendInfo {
    return { name: 'postgresql', type: 'production', durable: true, multiProcess: true };
  }

  async read(runId: string, key: string): Promise<EffectRecord> {
    const rows = await this.sql`
      SELECT status, value
      FROM nexora_effect_steps
      WHERE run_id = ${runId} AND effect_key = ${key}
    `;
    if (rows.length === 0) return { status: 'absent' };
    if (rows[0].status === 'running') return { status: 'running' };
    if (rows[0].status === 'done') return { status: 'done', value: rows[0].value };
    throw new Error(`Invalid effect status ${JSON.stringify(rows[0].status)}`);
  }

  async start(runId: string, key: string, fencingToken = 0): Promise<boolean> {
    return this.sql.begin(async sql => {
      await assertFence(sql, runId, fencingToken);
      const rows = await sql`
        INSERT INTO nexora_effect_steps (run_id, effect_key, status)
        VALUES (${runId}, ${key}, 'running')
        ON CONFLICT (run_id, effect_key) DO NOTHING
        RETURNING effect_key
      `;
      return rows.length > 0;
    });
  }

  async finish(
    runId: string,
    key: string,
    value: unknown,
    fencingToken = 0,
  ): Promise<void> {
    await this.sql.begin(async sql => {
      await assertFence(sql, runId, fencingToken);
      await sql`
        INSERT INTO nexora_effect_steps (run_id, effect_key, status, value)
        VALUES (${runId}, ${key}, 'done', ${jsonParam(sql, value)})
        ON CONFLICT (run_id, effect_key) DO UPDATE
        SET status = 'done', value = EXCLUDED.value, updated_at = NOW()
      `;
    });
  }

  async forget(runId: string, key: string, fencingToken = 0): Promise<void> {
    await this.sql.begin(async sql => {
      await assertFence(sql, runId, fencingToken);
      await sql`
        DELETE FROM nexora_effect_steps
        WHERE run_id = ${runId} AND effect_key = ${key} AND status = 'running'
      `;
    });
  }

  async acquire(runId: string, owner: string, ttlMs: number): Promise<number> {
    if (!owner) throw new Error('Effect lease owner must not be empty');
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error('Effect lease ttlMs must be a non-negative finite number');
    }
    const rows = await this.sql`
      INSERT INTO nexora_effect_leases (run_id, owner, token, expires_at)
      VALUES (${runId}, ${owner}, 1, NOW() + (${ttlMs} * INTERVAL '1 millisecond'))
      ON CONFLICT (run_id) DO UPDATE
      SET owner = EXCLUDED.owner,
          token = CASE
            WHEN nexora_effect_leases.owner = EXCLUDED.owner
              THEN nexora_effect_leases.token
            ELSE nexora_effect_leases.token + 1
          END,
          expires_at = EXCLUDED.expires_at
      WHERE nexora_effect_leases.owner = EXCLUDED.owner
         OR nexora_effect_leases.expires_at <= NOW()
      RETURNING token
    `;
    if (rows.length === 0) return 0;
    const token = Number(rows[0].token);
    if (!Number.isSafeInteger(token) || token <= 0) {
      throw new Error(`Invalid effect fencing token ${JSON.stringify(rows[0].token)}`);
    }
    return token;
  }

  async release(runId: string, owner: string): Promise<void> {
    await this.sql`
      UPDATE nexora_effect_leases
      SET owner = '', expires_at = NOW()
      WHERE run_id = ${runId} AND owner = ${owner}
    `;
  }

  async enqueueInput(runId: string, inputId: string, value: unknown): Promise<boolean> {
    const rows = await this.sql`
      INSERT INTO nexora_runtime_inputs (run_id, input_id, status, value)
      VALUES (${runId}, ${inputId}, 'pending', ${jsonParam(this.sql, value)})
      ON CONFLICT (run_id, input_id) DO NOTHING
      RETURNING input_id
    `;
    return rows.length > 0;
  }

  async listInputs(runId: string): Promise<RuntimeInputRecord[]> {
    const rows = await this.sql`
      SELECT input_id, status, value, sequence
      FROM nexora_runtime_inputs
      WHERE run_id = ${runId}
      ORDER BY sequence
    `;
    return rows.map(row => ({
      inputId: String(row.input_id),
      status: row.status as RuntimeInputRecord['status'],
      value: row.value,
      sequence: Number(row.sequence),
    }));
  }

  async claimInput(runId: string, inputId: string, fencingToken = 0): Promise<void> {
    await this.sql.begin(async sql => {
      await assertFence(sql, runId, fencingToken);
      await sql`
        UPDATE nexora_runtime_inputs
        SET status = 'claimed'
        WHERE run_id = ${runId} AND input_id = ${inputId}
          AND status NOT IN ('admitted', 'discarded')
      `;
    });
  }

  async admitInputs(runId: string, inputIds: string[], fencingToken = 0): Promise<void> {
    if (inputIds.length === 0) return;
    await this.sql.begin(async sql => {
      await assertFence(sql, runId, fencingToken);
      await sql`
        UPDATE nexora_runtime_inputs
        SET status = 'admitted', admitted_at = NOW()
        WHERE run_id = ${runId}
          AND input_id IN ${sql(inputIds)}
          AND status <> 'discarded'
      `;
    });
  }

  async discardInputs(runId: string, inputIds: string[], fencingToken = 0): Promise<void> {
    if (inputIds.length === 0) return;
    await this.sql.begin(async sql => {
      await assertFence(sql, runId, fencingToken);
      await sql`
        UPDATE nexora_runtime_inputs
        SET status = 'discarded'
        WHERE run_id = ${runId} AND input_id IN ${sql(inputIds)}
      `;
    });
  }
}

async function assertFence(sql: Sql, runId: string, presentedToken: number): Promise<void> {
  const rows = await sql`
    SELECT token
    FROM nexora_effect_leases
    WHERE run_id = ${runId}
    FOR UPDATE
  `;
  const issuedToken = rows.length > 0 ? Number(rows[0].token) : 0;
  if (presentedToken !== 0 && presentedToken < issuedToken) {
    throw new EffectWriteFencedError(runId, presentedToken, issuedToken);
  }
}
