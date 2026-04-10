/**
 * @nexora/store-json — JSON 파일 기반 store 구현체.
 */

export { ConversationStoreJson } from './conversation.js';
export { KnowledgeStoreJson } from './knowledge.js';
export { ScheduleStoreJson } from './schedule.js';
export { ContextStoreJson } from './context-store.js';
export { AuditStoreJson } from './audit.js';
export { ToolContextStoreJson } from './tool-context.js';

import { ConversationStoreJson } from './conversation.js';
import { KnowledgeStoreJson } from './knowledge.js';
import { ScheduleStoreJson } from './schedule.js';
import { ContextStoreJson } from './context-store.js';
import { AuditStoreJson } from './audit.js';
import { ToolContextStoreJson } from './tool-context.js';

export interface JsonStoreProvider {
  conversation: ConversationStoreJson;
  knowledge: KnowledgeStoreJson;
  schedule: ScheduleStoreJson;
  context: ContextStoreJson;
  audit: AuditStoreJson;
  toolContext: ToolContextStoreJson;
}

/** 모든 JSON store를 한 번에 생성 */
export function createJsonStoreProvider(dataDir: string): JsonStoreProvider {
  return {
    conversation: new ConversationStoreJson(dataDir),
    knowledge: new KnowledgeStoreJson(dataDir),
    schedule: new ScheduleStoreJson(dataDir),
    context: new ContextStoreJson(dataDir),
    audit: new AuditStoreJson(dataDir),
    toolContext: new ToolContextStoreJson(dataDir),
  };
}
