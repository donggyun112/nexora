/**
 * @dongkseo/store — Store 인터페이스 re-export + 팩토리.
 *
 * contracts의 store 인터페이스를 편의상 re-export하고,
 * 구현체를 동적으로 생성하는 팩토리를 제공.
 */

// ─── Store: 영속화 진입점 (인터페이스 re-export + 백엔드 팩토리) ─────────────
// 섹션 맵 (에이전트용: 무엇이 어느 파일에 있는지 — 정확한 타입은 해당 파일을 signatures 모드로)
//   인터페이스   @dongkseo/contracts  ConversationStore, KnowledgeStore, ScheduleStore,
//                                     ContextStore, AuditStore, ToolContextStore, SuspendedTurnStore (+ 부속 타입)
//   팩토리       ./factory     createStoreProvider, warnDevStores
//   설정/번들    ./factory     StoreConfig, StoreProvider
//   구현체       @dongkseo/store-json | store-pg (동적 import) · store-memory (직접 사용)

export type {
  ConversationStore,
  KnowledgeStore,
  KnowledgeTopic,
  ScheduleStore,
  ScheduledJob,
  ContextStore,
  DailyContext,
  AuditStore,
  AuditEntry,
  AuditFilter,
  ToolContextStore,
  ToolCallRecord,
  ToolResultRecord,
  ToolContextRecord,
  SuspendedTurnStore,
  SuspendedTurnState,
  ArtifactChannel,
  ArtifactRef,
  ArtifactPublishOptions,
} from '@dongkseo/contracts';

export { createStoreProvider, warnDevStores } from './factory.js';
export type { StoreConfig, StoreProvider } from './factory.js';
