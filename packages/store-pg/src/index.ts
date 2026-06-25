// ─── Store-PG: @dongkseo/store 백엔드 계약의 PostgreSQL + Redis 구현 ─────────
//
// store-json 대비 프로덕션 특성: 영속(재시작 생존) · 멀티프로세스 안전 · Redis 분산 공유.
//
// 섹션 맵 (에이전트용: 무엇이 어느 파일에 있는지 — 정확한 타입은 해당 파일을 signatures 모드로)
//   PG 커넥션      ./pg-client        createPgClient, PgOptions, Sql   (풀 생성·스키마 init·종료)
//   Conversation   ./conversation     ConversationStorePg              (선형 대화 기록)
//   Session tree   ./session-tree     TreeConversationStorePg          (분기 가능한 세션 트리)
//   Transcript     ./transcript       TranscriptStorePg                (ContentBlock 단위 기록)
//   Knowledge      ./knowledge        KnowledgeStorePg
//   Schedule       ./schedule         ScheduleStorePg
//   Context        ./context-store    ContextStorePg
//   Audit          ./audit            AuditStorePg
//   Tool context   ./tool-context     ToolContextStorePg
//   Suspended turn ./suspended-turn   SuspendedTurnStorePg             (HITL 일시중단 턴)
//   Artifact       ./artifact         ArtifactChannelPg                (에이전트 간 산출물 공유)
//   Provider       ./index            PgStoreProvider, createPgStoreProvider (커넥션 1개로 전부 생성)
//   Rate limiter   ./redis-rate-limiter  createRedisRateLimiter, DistributedRateLimiter (Redis 분산)
//   Budget         ./redis-budget        createRedisBudgetTracker, DistributedBudgetTracker (Redis 분산)

export { createPgClient } from './pg-client.js';
export type { PgOptions, Sql } from './pg-client.js';

export { ConversationStorePg } from './conversation.js';
export { KnowledgeStorePg } from './knowledge.js';
export { AuditStorePg } from './audit.js';
export { ScheduleStorePg } from './schedule.js';
export { ContextStorePg } from './context-store.js';
export { ToolContextStorePg } from './tool-context.js';
export { TranscriptStorePg } from './transcript.js';
export { SuspendedTurnStorePg } from './suspended-turn.js';
export { TreeConversationStorePg } from './session-tree.js';
export { ArtifactChannelPg } from './artifact.js';
export { WorkspaceStateStorePg } from './workspace-state.js';

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
import { SuspendedTurnStorePg } from './suspended-turn.js';
import { ArtifactChannelPg } from './artifact.js';
import { WorkspaceStateStorePg } from './workspace-state.js';

export interface PgStoreProvider {
  conversation: ConversationStorePg;
  knowledge: KnowledgeStorePg;
  audit: AuditStorePg;
  schedule: ScheduleStorePg;
  context: ContextStorePg;
  toolContext: ToolContextStorePg;
  transcript: TranscriptStorePg;
  suspendedTurn: SuspendedTurnStorePg;
  artifact: ArtifactChannelPg;
  workspaceState: WorkspaceStateStorePg;
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
    suspendedTurn: new SuspendedTurnStorePg(sql),
    artifact: new ArtifactChannelPg(sql),
    workspaceState: new WorkspaceStateStorePg(sql),
  };
}
