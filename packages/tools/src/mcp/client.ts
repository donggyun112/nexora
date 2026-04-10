/**
 * MCP Client Bridge — 외부 MCP 서버를 ToolDefinition으로 변환.
 *
 * MCP SDK를 직접 의존하지 않음 — 사용자가 McpClientLike 인스턴스를 주입.
 *
 * 사용:
 *   const client: McpClientLike = await createSdkClient(...);  // 사용자 코드
 *   const tools = await mcpClientToTools(client, { prefix: 'mcp_' });
 *   registry.registerAll(tools);
 */

import type { ToolDefinition, ToolResult } from '@nexora/contracts';
import { textResult, errorResult } from '@nexora/contracts';
import type { McpClientLike } from './types.js';

export interface McpClientBridgeOptions {
  /** 도구 이름 prefix (충돌 방지) */
  prefix?: string;
  /** 특정 도구만 임포트 */
  allowed?: string[];
  /** 차단할 도구 */
  blocked?: string[];
}

/**
 * MCP 서버의 도구 목록을 가져와 ToolDefinition 배열로 변환.
 */
export async function mcpClientToTools(
  client: McpClientLike,
  options: McpClientBridgeOptions = {},
): Promise<ToolDefinition[]> {
  const list = await client.listTools();
  const prefix = options.prefix ?? '';
  const allowed = options.allowed ? new Set(options.allowed) : null;
  const blocked = options.blocked ? new Set(options.blocked) : null;

  const tools: ToolDefinition[] = [];

  for (const desc of list.tools) {
    if (allowed && !allowed.has(desc.name)) continue;
    if (blocked && blocked.has(desc.name)) continue;

    const toolName = `${prefix}${desc.name}`;
    tools.push({
      name: toolName,
      description: desc.description ?? `MCP tool: ${desc.name}`,
      parameters: desc.inputSchema,
      execute: async (_id, input): Promise<ToolResult> => {
        try {
          const result = await client.callTool({
            name: desc.name,
            arguments: (input ?? {}) as Record<string, unknown>,
          });
          return mcpResultToToolResult(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return errorResult(`MCP tool ${desc.name} failed: ${msg}`);
        }
      },
    });
  }

  return tools;
}

function mcpResultToToolResult(result: { content: unknown[]; isError?: boolean }): ToolResult {
  if (result.isError) {
    const text = extractText(result.content);
    return errorResult(text || 'MCP tool returned error');
  }
  const text = extractText(result.content);
  return textResult(text);
}

function extractText(content: unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as { type?: string; text?: string };
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      }
    }
  }
  return parts.join('\n');
}
