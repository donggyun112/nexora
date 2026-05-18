import type { TenantAgentScope } from './context.js';

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
  /** 현재 테넌트 ID */
  tenantId: string;

  /** Shared tenant-agent scope for policy, audit, and store namespaces. */
  scope?: TenantAgentScope;

  /** 작업 디렉토리 */
  workdir: string;

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
}

export interface SecretAccessor {
  get(key: string): Promise<string | undefined>;
}

export interface ToolLogger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export type ToolResult =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'error'; message: string };

/** 텍스트 결과 헬퍼 — 기존 tool-helpers.ts의 text() 함수와 동일 역할 */
export function textResult(text: string): ToolResult {
  return { type: 'text', text };
}

export function errorResult(message: string): ToolResult {
  return { type: 'error', message };
}
