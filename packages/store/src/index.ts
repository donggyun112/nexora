/**
 * @nexora/store — Store 인터페이스 re-export + 팩토리.
 *
 * contracts의 store 인터페이스를 편의상 re-export하고,
 * 구현체를 동적으로 생성하는 팩토리를 제공.
 */

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
} from '@nexora/contracts';

export { createStoreProvider, warnDevStores } from './factory.js';
export type { StoreConfig, StoreProvider } from './factory.js';
