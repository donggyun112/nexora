/**
 * KnowledgeStorePg — PostgreSQL-backed knowledge store.
 */

import type { KnowledgeStore, KnowledgeTopic, StoreBackendInfo, DescribableStore } from '@dongkseo/contracts';
import type { Sql } from './pg-client.js';

export class KnowledgeStorePg implements KnowledgeStore, DescribableStore {
  constructor(private readonly sql: Sql) {}

  describeBackend(): StoreBackendInfo {
    return { name: 'postgresql', type: 'production', durable: true, multiProcess: true };
  }

  async list(namespace: string): Promise<KnowledgeTopic[]> {
    const rows = await this.sql`
      SELECT topic, content FROM nexora_knowledge
      WHERE namespace = ${namespace}
      ORDER BY topic ASC
    `;
    return rows.map(r => {
      const content = r.content as string;
      const firstHeading = content.split('\n').find(l => l.startsWith('# '))?.slice(2);
      return {
        name: r.topic as string,
        title: firstHeading ?? r.topic as string,
        lineCount: content.split('\n').filter(Boolean).length,
      };
    });
  }

  async read(namespace: string, topic: string): Promise<string | null> {
    const rows = await this.sql`
      SELECT content FROM nexora_knowledge
      WHERE namespace = ${namespace} AND topic = ${topic}
    `;
    return rows.length > 0 ? rows[0].content as string : null;
  }

  async write(namespace: string, topic: string, content: string): Promise<void> {
    await this.sql`
      INSERT INTO nexora_knowledge (namespace, topic, content, updated_at)
      VALUES (${namespace}, ${topic}, ${content}, NOW())
      ON CONFLICT (namespace, topic) DO UPDATE SET content = ${content}, updated_at = NOW()
    `;
  }

  async append(namespace: string, topic: string, content: string): Promise<void> {
    const existing = await this.read(namespace, topic);
    if (!existing) throw new Error(`Topic "${topic}" not found in namespace "${namespace}". Use write() first.`);
    await this.write(namespace, topic, existing + '\n' + content);
  }

  async delete(namespace: string, topic: string): Promise<void> {
    await this.sql`
      DELETE FROM nexora_knowledge WHERE namespace = ${namespace} AND topic = ${topic}
    `;
  }
}
