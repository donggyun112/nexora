/**
 * SuspendedTurnStorePg — PostgreSQL-backed suspended-turn store.
 */

import type { SuspendedTurnStore, SuspendedTurnState, StoreBackendInfo, DescribableStore } from '@dongkseo/contracts';
import type { Sql } from './pg-client.js';
import { jsonParam } from './helpers.js';

export class SuspendedTurnStorePg implements SuspendedTurnStore, DescribableStore {
  constructor(private readonly sql: Sql) {}

  describeBackend(): StoreBackendInfo {
    return { name: 'postgresql', type: 'production', durable: true, multiProcess: true };
  }

  async save(state: SuspendedTurnState): Promise<void> {
    await this.sql`
      INSERT INTO nexora_suspended_turns (pending_id, data)
      VALUES (${state.pendingId}, ${jsonParam(this.sql, state)})
      ON CONFLICT (pending_id) DO UPDATE SET data = ${jsonParam(this.sql, state)}
    `;
  }

  async load(pendingId: string): Promise<SuspendedTurnState | null> {
    const rows = await this.sql`
      SELECT data FROM nexora_suspended_turns WHERE pending_id = ${pendingId}
    `;
    return rows.length > 0 ? (rows[0].data as SuspendedTurnState) : null;
  }

  async delete(pendingId: string): Promise<void> {
    await this.sql`
      DELETE FROM nexora_suspended_turns WHERE pending_id = ${pendingId}
    `;
  }

  async listAwaiting(): Promise<SuspendedTurnState[]> {
    const rows = await this.sql`
      SELECT data FROM nexora_suspended_turns WHERE data->>'status' = 'awaiting'
    `;
    return rows.map(r => r.data as SuspendedTurnState);
  }
}
