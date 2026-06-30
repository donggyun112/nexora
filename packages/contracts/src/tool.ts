import type { TenantAgentScope } from './context.js';
import type { WorkspaceSession } from './workspace.js';
import type { BackgroundTaskRegistry, BackgroundTaskResult } from './background-task.js';
import type { TriggerHost } from './trigger.js';

/**
 * ToolDefinition — 도구 계약.
 *
 * 기존 runner.ts의 AgentTool 인터페이스를 일반화.
 * 모든 도구(builtin, MCP)가 이 계약을 따름.
 */

export interface ToolDefinition {
  /** 도구 고유 이름 */
  name: string;

  /** 도구 설명 (LLM이 도구 선택 시 참고) */
  description: string;

  /** 입력 파라미터 스키마 (JSON Schema) */
  parameters: Record<string, unknown>;

  /** 도구 실행 */
  execute(callId: string, input: unknown, ctx: ToolContext): Promise<ToolResult>;

  // ─── Tool metadata (claude-code buildTool defaults pattern) ────────
  // All optional — omitted means fail-closed defaults:
  //   isReadOnly=false, isConcurrencySafe=false, isDestructive=false

  /** True if this tool only reads state (no side effects). */
  isReadOnly?: boolean | ((input?: unknown) => boolean);

  /** True if safe to run concurrently with other tools. Default: false (sequential). */
  isConcurrencySafe?: boolean | ((input?: unknown) => boolean);

  /** True if this tool can cause irreversible changes. */
  isDestructive?: boolean | ((input?: unknown) => boolean);

  /** Max chars for the result text. Longer results are truncated. */
  maxResultSizeChars?: number;

  /**
   * Runtime availability check (hermes check_fn pattern).
   * Return false to hide this tool from the LLM schema entirely.
   * Use for env-var gating, API key checks, platform checks, etc.
   */
  checkAvailability?: () => boolean;

  /**
   * Platform-neutral hint about whether this tool's activity should surface
   * in user-facing chat (Discord embeds, web panels, etc.). Consumers — the
   * reporter middleware and outbound adapters — decide how to honor it:
   *
   *   - 'public' — show as inline progress (default for tools that are part
   *                 of the user-facing flow, e.g. "I'm running this command")
   *   - 'detail' — show in detail panels but not the main chat
   *   - 'silent' — never surface
   *
   * Fail-closed: undefined is treated as 'silent' by the default reporter
   * predicate. Tool authors who want their work visible must opt in.
   */
  visibility?: 'public' | 'detail' | 'silent';
}

export interface ToolContext {
  /** 현재 테넌트 ID (bootstrap에서 resolve된 구체값; 단일 테넌트면 DEFAULT_TENANT). */
  tenantId: string;

  /** Shared tenant-agent scope for policy, audit, and store namespaces. */
  scope?: TenantAgentScope;

  /** 작업 디렉토리 */
  workdir: string;

  /** Active workspace boundary for file/process tools. */
  workspace?: WorkspaceSession;

  /** 테넌트별 시크릿 접근 */
  secrets: SecretAccessor;

  /** 도구 실행 로깅 */
  logger: ToolLogger;

  /**
   * 취소 신호 (선택). AgentRunner가 idle timeout 또는 abort 시 활성화.
   * exec, fetch 등 장기 실행 도구는 이 signal을 child process / fetch options에 전달해야 한다.
   */
  signal?: AbortSignal;

  /**
   * Emit a progress event to the parent agent's event stream.
   * Used by delegate tool to relay child agent events in real-time.
   */
  emitProgress?: (message: string, agent?: string) => void;

  /**
   * Inject a user message into the calling agent's own in-flight loop.
   * Returns true if the parent turn is still active (the message was queued and
   * will be absorbed before the next LLM call); false if the turn has already
   * ended (the caller must deliver the result as a new turn instead).
   * Used by background-subagent delegation to fold a child's result back into
   * the parent's turn without blocking it.
   */
  steerSelf?: (message: string) => boolean;

  /**
   * Shared per-runtime background-task registry. Any tool that launches detached
   * work registers it here so the parent can observe/cancel it via check_tasks /
   * cancel_task. Undefined when the runtime doesn't support background tasks.
   */
  backgroundTasks?: BackgroundTaskRegistry;

  /**
   * Post-turn result sink. When a background task settles after the parent turn
   * has ended (steerSelf returned false / is absent), the result is delivered
   * here. The app wires this to start a new turn carrying the result. Undefined
   * → the result is logged and dropped.
   */
  deliverResult?: (result: BackgroundTaskResult) => void | Promise<void>;

  /**
   * Per-runtime trigger host: owns armed monitors (timer/event triggers) so they
   * survive across turns and can be listed/cancelled. Undefined when the runtime
   * doesn't support monitors.
   */
  triggers?: TriggerHost;

  /**
   * Per-fanout resource lock. Write/edit/store tools route their read-modify-write
   * critical section through `runExclusive(resourcePath, fn)` so concurrent child
   * agents (e.g. a parallel delegate fan-out sharing this lock) can't lose updates
   * on the same resource. Atomic rename prevents torn reads but NOT lost updates;
   * serializing the whole read+write per key does. Same key → serialized; disjoint
   * keys → parallel. Undefined (single agent) → tools run directly, zero overhead.
   * Satisfied structurally by `KeyedSerializer` from @dongkseo/core.
   */
  resourceLock?: ResourceLock;

  /**
   * Per-session file-read history: absolute path → last read metadata. The read
   * tool populates it and, on an identical re-read (same path/offset/limit) with
   * an unchanged mtime, returns an "unchanged" stub instead of re-sending the
   * whole file — the earlier result is still in context, so a second full copy
   * just wastes cache. Created ONCE per session/runtime (not per call) so it
   * survives across tool calls. Undefined (e.g. internal callers) → dedup off.
   */
  readFileState?: Map<string, FileReadState>;
}

export interface FileReadState {
  /** mtimeMs floored to an integer for stable equality comparison. */
  mtimeMs: number;
  /** Byte size at read time — a cheap second signal so a same-mtime rewrite of a
   * different length is not mistaken for unchanged. */
  size: number;
  /** 1-based start line of the cached read, if any. */
  offset?: number;
  /** Line limit of the cached read, if any. */
  limit?: number;
}

/**
 * Serializes critical sections by key. Same key runs one-at-a-time (the next
 * caller waits until the current `fn` settles); different keys run concurrently.
 */
export interface ResourceLock {
  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export interface SecretAccessor {
  get(key: string): Promise<string | undefined>;
}

export interface ToolLogger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/** A single block inside a multimodal `content` ToolResult. */
export type ToolResultContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type ToolResult =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  /**
   * Ordered multimodal result — interleaved text and (multiple) images in one
   * tool result. A single `image` result can carry only one picture; tools that
   * return several images or text+image mixes (PDF page extraction, notebook
   * cells) use this. The transcript recorder flattens `blocks` into the user
   * turn's content array in order.
   */
  | { type: 'content'; blocks: ToolResultContentBlock[] }
  | { type: 'error'; message: string }
  | { type: 'suspend'; pendingId: string };

/** 텍스트 결과 헬퍼 — 기존 tool-helpers.ts의 text() 함수와 동일 역할 */
export function textResult(text: string): ToolResult {
  return { type: 'text', text };
}

export function errorResult(message: string): ToolResult {
  return { type: 'error', message };
}

/** Multimodal result helper — interleaved text/image blocks in order. */
export function contentResult(blocks: ToolResultContentBlock[]): ToolResult {
  return { type: 'content', blocks };
}

export function suspendResult(pendingId: string): ToolResult {
  return { type: 'suspend', pendingId };
}
