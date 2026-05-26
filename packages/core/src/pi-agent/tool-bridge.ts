/**
 * Nexora ToolDefinition[] → pi-agent-core AgentTool[].
 *
 * Nexora ToolDefinition.parameters는 JSON Schema 객체, pi의 Tool.parameters는
 * TypeBox TSchema. 호환되지만 TypeScript 타입은 별개라 캐스팅 필요.
 */

import type { ToolDefinition, ToolExecutor } from '@nexora/contracts';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TSchema } from '@earendil-works/pi-ai';

export function toAgentTools(
  tools: ToolDefinition[],
  executor: ToolExecutor,
): AgentTool<TSchema>[] {
  throw new Error('not implemented');
}
