/**
 * WorkspaceStateStorePg — PostgreSQL-backed workspace-state store.
 * 참고: suspended-turn.ts (JSONB upsert by primary key).
 */

import type {
  WorkspaceStateStore,
  SandboxSessionState,
  StoreBackendInfo,
  DescribableStore,
} from '@dongkseo/contracts';
import type { Sql } from './pg-client.js';
import { jsonParam } from './helpers.js';

export class WorkspaceStateStorePg implements WorkspaceStateStore, DescribableStore {
  constructor(private readonly sql: Sql) {}

  describeBackend(): StoreBackendInfo {
    return { name: 'postgresql', type: 'production', durable: true, multiProcess: true };
  }

  async save(conversationId: string, state: SandboxSessionState): Promise<void> {
    await this.sql`
      INSERT INTO nexora_workspace_state (conversation_id, data)
      VALUES (${conversationId}, ${jsonParam(this.sql, state)})
      ON CONFLICT (conversation_id) DO UPDATE SET data = ${jsonParam(this.sql, state)}
    `;
  }

  async load(conversationId: string): Promise<SandboxSessionState | null> {
    const rows = await this.sql`
      SELECT data FROM nexora_workspace_state WHERE conversation_id = ${conversationId}
    `;
    return rows.length > 0 ? (rows[0].data as SandboxSessionState) : null;
  }

  async delete(conversationId: string): Promise<void> {
    await this.sql`
      DELETE FROM nexora_workspace_state WHERE conversation_id = ${conversationId}
    `;
  }
}
