/**
 * ScheduleStorePg — PostgreSQL-backed schedule store.
 */

import type { ScheduleStore, ScheduledJob, StoreBackendInfo, DescribableStore } from '@nexora/contracts';
import type { Sql } from './pg-client.js';
import { jsonParam } from './helpers.js';

export class ScheduleStorePg implements ScheduleStore, DescribableStore {
  constructor(private readonly sql: Sql) {}

  describeBackend(): StoreBackendInfo {
    return { name: 'postgresql', type: 'production', durable: true, multiProcess: true };
  }

  async save(namespace: string, job: ScheduledJob): Promise<void> {
    await this.sql`
      INSERT INTO nexora_schedules (namespace, job_id, data)
      VALUES (${namespace}, ${job.jobId}, ${jsonParam(this.sql, job)})
      ON CONFLICT (namespace, job_id) DO UPDATE SET data = ${jsonParam(this.sql, job)}
    `;
  }

  async remove(namespace: string, jobId: string): Promise<void> {
    await this.sql`
      DELETE FROM nexora_schedules WHERE namespace = ${namespace} AND job_id = ${jobId}
    `;
  }

  async loadAll(namespace: string): Promise<ScheduledJob[]> {
    const rows = await this.sql`
      SELECT data FROM nexora_schedules WHERE namespace = ${namespace}
    `;
    return rows.map(r => r.data as ScheduledJob);
  }
}
