/**
 * ToolContextStorePg — PostgreSQL-backed tool context store.
 */

import type {
  ToolContextStore,
  ToolCallRecord,
  ToolResultRecord,
  ToolContextRecord,
  StoreBackendInfo,
  DescribableStore,
} from '@dongkseo/contracts';
import type { Sql } from './pg-client.js';
import { jsonParam } from './helpers.js';

export class ToolContextStorePg implements ToolContextStore, DescribableStore {
  constructor(private readonly sql: Sql) {}

  describeBackend(): StoreBackendInfo {
    return { name: 'postgresql', type: 'production', durable: true, multiProcess: true };
  }

  async recordCall(scope: string, turnId: string, call: ToolCallRecord): Promise<void> {
    const record: ToolContextRecord = { type: 'call', ...call };
    await this.sql`
      INSERT INTO nexora_tool_context (scope, turn_id, record)
      VALUES (${scope}, ${turnId}, ${jsonParam(this.sql, record)})
    `;
  }

  async recordResult(scope: string, turnId: string, result: ToolResultRecord): Promise<void> {
    const record: ToolContextRecord = { type: 'result', ...result };
    await this.sql`
      INSERT INTO nexora_tool_context (scope, turn_id, record)
      VALUES (${scope}, ${turnId}, ${jsonParam(this.sql, record)})
    `;
  }

  async loadContext(scope: string, turnId: string): Promise<ToolContextRecord[]> {
    const rows = await this.sql`
      SELECT record FROM nexora_tool_context
      WHERE scope = ${scope} AND turn_id = ${turnId}
      ORDER BY id ASC
    `;
    return rows.map(r => r.record as ToolContextRecord);
  }

  async cleanup(retentionDays: number): Promise<number> {
    const result = await this.sql`
      DELETE FROM nexora_tool_context
      WHERE created_at < NOW() - INTERVAL '1 day' * ${retentionDays}
    `;
    return result.count;
  }
}
