// ─── Tools: 에이전트가 실제로 호출하는 도구 시스템 ─────────────────────────
//
// 섹션 맵 (에이전트용: 무엇이 어느 파일에 있는지 — 정확한 타입은 해당 파일을 signatures 모드로)
//   Registry      ./registry           ToolRegistry, ToolsetRegistry, TOOL_GROUPS, TOOL_PROFILES,
//                                       resolveToolNames, resolveProfile, assembleToolsWithPolicy
//   내장 도구     ./builtin            create{Read,Grep,Write,Edit,Exec,Knowledge}Tool
//   웹/이미지     ./builtin            create{WebSearch,WebFetch,ImageSearch}Tool, createBraveBackend
//   협업/HITL     ./builtin            create{Delegate,Handraise,PublishTopic}Tool
//   Handraise     ./handraise          HandraiseInbox, HandraisePolicy, approval(승인) 게이트(PreToolUse/OnResume)
//   MCP 브리지    ./mcp                mcpClientToTools(외부→도구), createMcpServerBridge(도구→외부)
//   Reporter      ./reporter           createReporterMiddleware, reportTopic (도구 활동 이벤트)
//
// 도구 결과 타입(ToolDefinition, ToolResult, textResult …)은 @dongkseo/contracts 가 정의한다.

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
export {
  mcpClientToTools,
  createStdioMcpBridgeTools,
  createMcpServerBridge,
} from './mcp/index.js';
export type {
  McpClientLike,
  McpToolDescriptor,
  McpCallResult,
  McpClientBridgeOptions,
  StdioMcpBridgeOptions,
  McpServerBridge,
} from './mcp/index.js';
