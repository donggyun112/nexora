/**
 * @nexora/store-pg — PostgreSQL + Redis production store implementations.
 *
 * All 6 core stores + session tree + distributed rate limiter + budget tracker.
 * Drop-in replacements for @nexora/store-json with production characteristics:
 * - Durable (survives restart)
 * - Multi-process safe (concurrent access)
 * - Distributed (Redis-backed shared state)
 */

export { createPgClient } from './pg-client.js';
export type { PgOptions, Sql } from './pg-client.js';

export { ConversationStorePg } from './conversation.js';
export { KnowledgeStorePg } from './knowledge.js';
export { AuditStorePg } from './audit.js';
export { ScheduleStorePg } from './schedule.js';
export { ContextStorePg } from './context-store.js';
export { ToolContextStorePg } from './tool-context.js';
export { TranscriptStorePg } from './transcript.js';
export { TreeConversationStorePg } from './session-tree.js';

export { createRedisRateLimiter } from './redis-rate-limiter.js';
export type {
  RedisRateLimiterOptions,
  RedisLike,
  DistributedRateLimiter,
} from './redis-rate-limiter.js';

export { createRedisBudgetTracker } from './redis-budget.js';
export type {
  RedisBudgetOptions,
  RedisBudgetClient,
  DistributedBudgetTracker,
} from './redis-budget.js';

import type { Sql } from './pg-client.js';
import { ConversationStorePg } from './conversation.js';
import { KnowledgeStorePg } from './knowledge.js';
import { AuditStorePg } from './audit.js';
import { ScheduleStorePg } from './schedule.js';
import { ContextStorePg } from './context-store.js';
import { ToolContextStorePg } from './tool-context.js';
import { TranscriptStorePg } from './transcript.js';

export interface PgStoreProvider {
  conversation: ConversationStorePg;
  knowledge: KnowledgeStorePg;
  audit: AuditStorePg;
  schedule: ScheduleStorePg;
  context: ContextStorePg;
  toolContext: ToolContextStorePg;
  transcript: TranscriptStorePg;
}

/** Create all core stores from a single Postgres connection. */
export function createPgStoreProvider(sql: Sql): PgStoreProvider {
  return {
    conversation: new ConversationStorePg(sql),
    knowledge: new KnowledgeStorePg(sql),
    audit: new AuditStorePg(sql),
    schedule: new ScheduleStorePg(sql),
    context: new ContextStorePg(sql),
    toolContext: new ToolContextStorePg(sql),
    transcript: new TranscriptStorePg(sql),
  };
}
