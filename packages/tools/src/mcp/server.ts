/**
 * MCP Server Bridge — Nexora 내부 도구를 MCP 서버로 노출.
 *
 * MCP SDK를 직접 의존하지 않음 — handler 함수를 반환.
 * 사용자가 SDK Server에 connect() 하는 형태.
 */

import type { ToolDefinition, ToolContext } from '@nexora/contracts';
import type { McpToolDescriptor, McpCallResult } from './types.js';

export interface McpServerBridge {
  /** SDK Server.setRequestHandler('tools/list', ...) 에 연결 */
  listToolsHandler(): { tools: McpToolDescriptor[] };
  /** SDK Server.setRequestHandler('tools/call', ...) 에 연결 */
  callToolHandler(args: { name: string; arguments: Record<string, unknown> }): Promise<McpCallResult>;
}

/**
 * ToolDefinition 배열을 MCP 핸들러 쌍으로 변환.
 *
 * 사용:
 *   const bridge = createMcpServerBridge([execTool, readTool], context);
 *   sdkServer.setRequestHandler('tools/list', () => bridge.listToolsHandler());
 *   sdkServer.setRequestHandler('tools/call', (req) => bridge.callToolHandler(req.params));
 */
export function createMcpServerBridge(
  tools: ToolDefinition[],
  context: ToolContext,
): McpServerBridge {
  const toolMap = new Map(tools.map(t => [t.name, t]));

  return {
    listToolsHandler() {
      return {
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.parameters,
        })),
      };
    },

    async callToolHandler({ name, arguments: args }) {
      const tool = toolMap.get(name);
      if (!tool) {
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }

      const callId = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      try {
        const result = await tool.execute(callId, args, context);

        if (result.type === 'text') {
          return { content: [{ type: 'text', text: result.text }] };
        }
        if (result.type === 'image') {
          return {
            content: [{
              type: 'image',
              data: result.data,
              mimeType: result.mimeType,
            }],
          };
        }
        if (result.type === 'error') {
          return {
            content: [{ type: 'text', text: result.message }],
            isError: true,
          };
        }
        // suspend — MCP 컨텍스트는 HITL 중단을 이어갈 수 없다. pendingId 만 알리고 에러로 종료.
        return {
          content: [{ type: 'text', text: `Tool suspended (pendingId: ${result.pendingId}) — not resumable over MCP.` }],
          isError: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: msg }],
          isError: true,
        };
      }
    },
  };
}
