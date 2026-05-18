/**
 * @nexora/tools — tool system.
 *
 * - registry: tool registration / filtering / assembly
 * - builtin: 8 stock tools (exec, read, grep, write, edit, knowledge,
 *   web-search, handraise)
 * - handraise: HandraiseInbox + HandraisePolicy (HITL primitive)
 * - mcp: bidirectional MCP bridge
 */

export {
  ToolRegistry,
  ToolsetRegistry,
  TOOL_GROUPS,
  TOOL_PROFILES,
  resolveToolNames,
  resolveProfile,
  applyToolPolicyPipeline,
  resolveToolPolicy,
  assembleToolsWithPolicy,
} from './registry.js';
export type {
  ToolFilter,
  ToolsetDefinition,
  ToolProfileId,
  ToolPolicyLayer,
  ResolveToolPolicyOptions,
  ResolvedToolPolicy,
} from './registry.js';

export * from './builtin/index.js';
export * from './handraise/index.js';
export * from './reporter/index.js';
export * from './mcp/index.js';
