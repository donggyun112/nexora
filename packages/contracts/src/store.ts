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

  /**
   * Full-text search across conversation messages (hermes FTS5 pattern).
   * Returns matching messages with their conversation IDs.
   * Implementations may use FTS5 (SQLite), tsvector (PostgreSQL),
   * or simple substring matching (in-memory).
   */
  search?(query: string, options?: ConversationSearchOptions): Promise<ConversationSearchResult[]>;
}

export interface ConversationSearchOptions {
  /** Limit results. Default: 20. */
  limit?: number;
  /** Only search within this conversation. */
  conversationId?: string;
  /** Only search messages with this role. */
  role?: 'user' | 'assistant';
}

export interface ConversationSearchResult {
  conversationId: string;
  message: ChatMessage;
  /** Relevance score (0–1). Implementation-dependent. */
  score?: number;
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

// ─── Artifact Channel ─────────────────────────────────────────────────────
// 에이전트 간 산출물 공유 — conversationId(scope) 키. 로컬 파일 공유(.scratch) 대체.
// producer가 자기 샌드박스 산출물을 publish(ref 반환) → ref를 메시지로 전달 →
// consumer가 fetch(ref)로 bytes 수령. 격리 유지, 명시적 계약, TTL은 cleanup 스윕으로 실현.

export interface ArtifactRef {
  /** Globally-unique opaque handle. fetch()는 이것만으로 조회 가능. */
  ref: string;
  /** 소유 스코프 (conversationId 또는 tenant+conversation). */
  scope: string;
  /** 사람이 읽는 이름 (예: 'slide-1.png'). */
  name: string;
  /** MIME 타입. 기본 application/octet-stream. */
  mediaType: string;
  /** 바이트 크기. */
  size: number;
  /** 생성 시각 (epoch ms). */
  createdAt: number;
  /** 만료 시각 (epoch ms). 없으면 무기한. */
  expiresAt?: number;
  /** 임의 메타데이터. */
  meta?: Record<string, unknown>;
}

export interface ArtifactPublishOptions {
  /** MIME 타입. 기본 application/octet-stream. */
  mediaType?: string;
  /** 생존 기간(ms). 지나면 cleanup()이 제거. 없으면 무기한. */
  ttlMs?: number;
  /** 임의 메타데이터. */
  meta?: Record<string, unknown>;
}

export interface ArtifactChannel {
  /** 산출물 게시 → ref 반환. */
  publish(
    scope: string,
    name: string,
    bytes: Buffer,
    options?: ArtifactPublishOptions,
  ): Promise<ArtifactRef>;
  /** ref로 바이트 조회. 없으면 null. (만료는 검사하지 않음 — cleanup 책임.) */
  fetch(ref: string): Promise<Buffer | null>;
  /** scope의 아티팩트 메타 목록 (바이트 제외), createdAt 오름차순. */
  list(scope: string): Promise<ArtifactRef[]>;
  /** ref 삭제 (없으면 no-op). */
  delete(ref: string): Promise<void>;
  /** expiresAt <= now 인 아티팩트 제거 → 제거 개수. now 기본 Date.now(). */
  cleanup(now?: number): Promise<number>;
}
