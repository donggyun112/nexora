/**
 * AuditStorePg — PostgreSQL-backed audit store.
 */

import type { AuditStore, AuditEntry, AuditFilter, StoreBackendInfo, DescribableStore } from '@nexora/contracts';
import type { Sql } from './pg-client.js';
import { jsonParam } from './helpers.js';

export class AuditStorePg implements AuditStore, DescribableStore {
  constructor(private readonly sql: Sql) {}

  describeBackend(): StoreBackendInfo {
    return { name: 'postgresql', type: 'production', durable: true, multiProcess: true };
  }

  async record(namespace: string, entry: AuditEntry): Promise<void> {
    await this.sql`
      INSERT INTO nexora_audit (namespace, entry)
      VALUES (${namespace}, ${jsonParam(this.sql, entry)})
    `;
  }

  async query(namespace: string, filter?: AuditFilter): Promise<AuditEntry[]> {
    let rows;

    if (filter?.type && filter?.since && filter?.limit) {
      rows = await this.sql`
        SELECT entry FROM nexora_audit
        WHERE namespace = ${namespace}
          AND entry->>'type' = ${filter.type}
          AND (entry->>'timestamp')::bigint >= ${filter.since}
        ORDER BY created_at DESC LIMIT ${filter.limit}
      `;
    } else if (filter?.type) {
      rows = await this.sql`
        SELECT entry FROM nexora_audit
        WHERE namespace = ${namespace} AND entry->>'type' = ${filter.type}
        ORDER BY created_at DESC
      `;
    } else if (filter?.since) {
      rows = await this.sql`
        SELECT entry FROM nexora_audit
        WHERE namespace = ${namespace}
          AND (entry->>'timestamp')::bigint >= ${filter.since}
        ORDER BY created_at DESC
      `;
    } else if (filter?.limit) {
      rows = await this.sql`
        SELECT entry FROM nexora_audit
        WHERE namespace = ${namespace}
        ORDER BY created_at DESC LIMIT ${filter.limit}
      `;
    } else {
      rows = await this.sql`
        SELECT entry FROM nexora_audit
        WHERE namespace = ${namespace}
        ORDER BY created_at DESC
      `;
    }

    return rows.map(r => r.entry as AuditEntry);
  }
}
