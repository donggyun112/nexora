/**
 * MCP 양방향 브리지.
 *
 * - client: 외부 MCP 서버 → ToolDefinition (Nexora가 사용)
 * - server: 내부 ToolDefinition → MCP handler (외부에 노출)
 */

export type {
  McpClientLike,
  McpToolDescriptor,
  McpCallResult,
} from './types.js';

export { mcpClientToTools } from './client.js';
export type { McpClientBridgeOptions } from './client.js';

export { createStdioMcpBridgeTools } from './stdio.js';
export type { StdioMcpBridgeOptions } from './stdio.js';

export { createMcpServerBridge } from './server.js';
export type { McpServerBridge } from './server.js';
