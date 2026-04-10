/**
 * Store 계약 — 영속화 인터페이스.
 *
 * 기존 코드에서 Discord, 파일시스템, MongoDB에 흩어져 있던
 * 영속화 패턴을 단일 인터페이스로 통합.
 *
 * 구현체는 store-json, store-mongo 등 별도 패키지에서 제공.
 */

import type { ChatMessage } from './agent.js';

// ─── Conversation Store ───────────────────────────────────────────────────
// 기존: discord-history.ts (Discord 메시지 fetch), compaction.ts (요약 저장)

export interface ConversationStore {
  /** 대화 히스토리 조회 */
  getHistory(conversationId: string, limit?: number): Promise<ChatMessage[]>;

  /** 메시지 추가 */
  appendMessage(conversationId: string, message: ChatMessage): Promise<void>;

  /** 대화 압축 요약 저장 — 기존 compaction 결과를 Discord에 포스팅하던 것을 대체 */
  saveCompaction(conversationId: string, summary: string): Promise<void>;

  /** 대화 삭제 */
  deleteConversation(conversationId: string): Promise<void>;
}

// ─���─ Knowledge Store ──────────────────────────────────────────────────────
// 기존: knowledge.tool.ts (파일시스템 markdown)

export interface KnowledgeStore {
  /** 토픽 목록 */
  list(namespace: string): Promise<KnowledgeTopic[]>;

  /** 토픽 읽기 */
  read(namespace: string, topic: string): Promise<string | null>;

  /** 토픽 쓰기 (덮어쓰기) */
  write(namespace: string, topic: string, content: string): Promise<void>;

  /** 토픽에 내용 추가 */
  append(namespace: string, topic: string, content: string): Promise<void>;

  /** 토픽 삭제 */
  delete(namespace: string, topic: string): Promise<void>;
}

export interface KnowledgeTopic {
  name: string;
  title: string;
  lineCount: number;
}

// ─── Schedule Store ───────────────────────────────────────────────────────
// 기존: dynamic-job-store.ts (JSON 파일)

export interface ScheduleStore {
  /** 작업 저장/업데이트 */
  save(namespace: string, job: ScheduledJob): Promise<void>;

  /** 작업 삭제 */
  remove(namespace: string, jobId: string): Promise<void>;

  /** 네임스페이스의 모든 작업 로드 */
  loadAll(namespace: string): Promise<ScheduledJob[]>;
}

export interface ScheduledJob {
  jobId: string;
  taskName: string;
  cronExpression: string;
  description: string;
  oneShot: boolean;
  registeredAt: string;
  responseTarget?: { type: 'dm' | 'channel' | 'thread'; id: string };
}

// ─── Context Store ────────────────────────────────────────────────────────
// 기존: daily-context.ts (인메모리 + Discord 스레드 백업)

export interface ContextStore {
  /** 일일 컨텍스트 저장 */
  saveDailyContext(namespace: string, date: string, ctx: DailyContext): Promise<void>;

  /** 일일 컨텍스트 조회 */
  getDailyContext(namespace: string, date: string): Promise<DailyContext | null>;
}

export interface DailyContext {
  date: string;
  plan: string[];
  completedTasks: string[];
  dynamicJobs: string[];
}

// ─── Memory Store ─────────────────────────────────────────────────────────
// 기존: pm-memory.ts (Discord 스레드에 구조화된 텍스트)

export interface AuditStore {
  /** 감사 기록 추가 */
  record(namespace: string, entry: AuditEntry): Promise<void>;

  /** 감사 기록 조회 */
  query(namespace: string, filter?: AuditFilter): Promise<AuditEntry[]>;
}

export interface AuditEntry {
  id: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface AuditFilter {
  type?: string;
  since?: number;
  limit?: number;
}

// ─── Tool Context Store ───────────────────────────────────────────────────
// 기존: tool-context-store.ts (파일시스템 JSONL)

export interface ToolContextStore {
  /** 도구 호출 기록 */
  recordCall(scope: string, turnId: string, call: ToolCallRecord): Promise<void>;

  /** 도구 결과 기록 */
  recordResult(scope: string, turnId: string, result: ToolResultRecord): Promise<void>;

  /** 턴의 도구 컨텍스트 로드 */
  loadContext(scope: string, turnId: string): Promise<ToolContextRecord[]>;

  /** 오래된 컨텍스트 정리 */
  cleanup(retentionDays: number): Promise<number>;
}

export interface ToolCallRecord {
  toolCallId: string;
  name: string;
  input: unknown;
  timestamp: number;
}

export interface ToolResultRecord {
  toolCallId: string;
  output: string;
  isError: boolean;
  timestamp: number;
}

export type ToolContextRecord =
  | { type: 'call'; toolCallId: string; name: string; input: unknown; timestamp: number }
  | { type: 'result'; toolCallId: string; output: string; isError: boolean; timestamp: number };
