/**
 * Nexora ToolDefinition[] → pi-agent-core AgentTool[].
 *
 * Nexora ToolDefinition.parameters는 JSON Schema 객체, pi의 Tool.parameters는
 * TypeBox TSchema. 호환되지만 TypeScript 타입은 별개라 캐스팅 필요.
 */

import type { ToolDefinition, ToolExecutor } from '@nexora/contracts';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TSchema, TextContent, ImageContent } from '@earendil-works/pi-ai';

export function toAgentTools(
  tools: ToolDefinition[],
  executor: ToolExecutor,
): AgentTool<TSchema>[] {
  return tools.map(t => ({
    name: t.name,
    label: t.name,
    description: t.description,
    parameters: t.parameters as unknown as TSchema,
    execute: async (toolCallId: string, params: unknown, signal?: AbortSignal): Promise<AgentToolResult<unknown>> => {
      const raw = await executor.execute(t.name, toolCallId, params, signal);
      return normalizeResult(raw);
    },
  } as AgentTool<TSchema>));
}

function normalizeResult(raw: unknown): AgentToolResult<unknown> {
  if (typeof raw === 'string') {
    return {
      content: [{ type: 'text', text: raw } as TextContent],
      details: undefined,
    };
  }
  if (raw !== null && typeof raw === 'object' && 'content' in (raw as Record<string, unknown>)) {
    const r = raw as { content: (TextContent | ImageContent)[]; details?: unknown };
    return {
      content: r.content,
      details: r.details,
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(raw) } as TextContent],
    details: raw,
  };
}
