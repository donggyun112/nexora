/**
 * ContextStorePg — PostgreSQL-backed daily context store.
 */

import type { ContextStore, DailyContext, StoreBackendInfo, DescribableStore } from '@dongkseo/contracts';
import type { Sql } from './pg-client.js';
import { jsonParam } from './helpers.js';

export class ContextStorePg implements ContextStore, DescribableStore {
  constructor(private readonly sql: Sql) {}

  describeBackend(): StoreBackendInfo {
    return { name: 'postgresql', type: 'production', durable: true, multiProcess: true };
  }

  async saveDailyContext(namespace: string, date: string, ctx: DailyContext): Promise<void> {
    await this.sql`
      INSERT INTO nexora_context (namespace, date, data)
      VALUES (${namespace}, ${date}, ${jsonParam(this.sql, ctx)})
      ON CONFLICT (namespace, date) DO UPDATE SET data = ${jsonParam(this.sql, ctx)}
    `;
  }

  async getDailyContext(namespace: string, date: string): Promise<DailyContext | null> {
    const rows = await this.sql`
      SELECT data FROM nexora_context
      WHERE namespace = ${namespace} AND date = ${date}
    `;
    return rows.length > 0 ? rows[0].data as DailyContext : null;
  }
}
