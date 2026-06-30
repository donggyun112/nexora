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

import type { ToolDefinition, ToolResult } from '@dongkseo/contracts';
import { textResult, errorResult } from '@dongkseo/contracts';
import type { McpClientLike } from './types.js';

export interface McpClientBridgeOptions {
  /** 도구 이름 prefix (충돌 방지) */
  prefix?: string;
  /** 특정 도구만 임포트 */
  allowed?: string[];
  /** 차단할 도구 */
  blocked?: string[];
  /** MCP annotations(readOnlyHint/destructiveHint 등)를 ToolDefinition flags 로 옮김. 기본 true. */
  mapAnnotations?: boolean;
  /** 생성된 MCP 도구 결과 최대 길이. */
  maxResultSizeChars?: number;
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
    const tool: ToolDefinition = {
      name: toolName,
      description: desc.description ?? `MCP tool: ${desc.name}`,
      parameters: desc.inputSchema,
      ...(options.maxResultSizeChars ? { maxResultSizeChars: options.maxResultSizeChars } : {}),
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
    };

    if (options.mapAnnotations !== false) {
      if (desc.annotations?.readOnlyHint === true) {
        tool.isReadOnly = true;
        tool.isConcurrencySafe = true;
      }
      if (desc.annotations?.destructiveHint === true) {
        tool.isDestructive = true;
      }
    }

    tools.push(tool);
  }

  return tools;
}

function mcpResultToToolResult(result: {
  content: unknown[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  toolResult?: unknown;
}): ToolResult {
  if (result.isError) {
    const text = extractText(result.content);
    return errorResult(text || 'MCP tool returned error');
  }
  const text = extractText(result.content);
  if (text) return textResult(text);
  if (result.structuredContent) return textResult(JSON.stringify(result.structuredContent, null, 2));
  if (result.toolResult !== undefined) return textResult(JSON.stringify(result.toolResult, null, 2));
  return textResult('');
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
