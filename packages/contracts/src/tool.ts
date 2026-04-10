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
}

export interface ToolContext {
  /** 현재 테넌트 ID */
  tenantId: string;

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
