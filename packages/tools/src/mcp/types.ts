/**
 * MCP 공통 타입.
 *
 * @modelcontextprotocol/sdk를 직접 의존하지 않고
 * 최소 인터페이스만 정의 — 사용자가 실제 SDK 클라이언트를 어댑터로 주입.
 */

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  /** 결과 컨텐츠 (text 위주) */
  content: { type: 'text'; text: string }[] | { type: string; [k: string]: unknown }[];
  isError?: boolean;
}

/**
 * 외부 MCP 서버와 통신하는 최소 인터페이스.
 * @modelcontextprotocol/sdk의 Client 객체로부터 어댑터로 제공.
 */
export interface McpClientLike {
  /** 사용 가능한 도구 목록 */
  listTools(): Promise<{ tools: McpToolDescriptor[] }>;
  /** 도구 호출 */
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<McpCallResult>;
  /** 종료 */
  close?(): Promise<void>;
}
