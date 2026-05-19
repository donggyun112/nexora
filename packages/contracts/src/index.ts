// ─── Contracts: 모든 패키지가 공유하는 타입 ───────────────────────────────

export {
  createId,
  messageId,
  traceId,
  spanId,
  conversationId,
  auditId,
  jobId,
  w3cTraceId,
  w3cSpanId,
  toW3CTraceId,
  toW3CSpanId,
} from './id.js';

export type { AgentDefinition } from './define.js';
export { defineAgent } from './define.js';

export type {
  MessageEnvelope,
  MessageType,
  MessageMetadata,
} from './message.js';

export type {
  TopicString,
} from './topic.js';
export { topic, matchTopic, Topics } from './topic.js';

export type {
  AgentCard,
  AgentLimits,
} from './agent-card.js';

export type {
  WorkflowContract,
  WorkflowTrigger,
  WorkflowStep,
  WorkflowStepInput,
  StepTransition,
  RetryPolicy,
} from './workflow.js';

export type {
  ToolDefinition,
  ToolContext,
  SecretAccessor,
  ToolLogger,
  ToolResult,
} from './tool.js';
export { textResult, errorResult } from './tool.js';

export type {
  AgentInput,
  ChatMessage,
  ImageContent,
  AgentEvent,
  ToolCallSummary,
  AgentRuntime,
  AgentArchitecture,
  RuntimeServices,
  LLMProvider,
  LLMMessage,
  LLMContentBlock,
  LLMChunk,
  LLMOptions,
  LLMResponse,
  LLMUsage,
  ToolExecutor,
  ToolDefinitionSummary,
  MemoryProvider,
  AgentLogger,
} from './agent.js';

export type {
  ConversationStore,
  ConversationSearchOptions,
  ConversationSearchResult,
  KnowledgeStore,
  KnowledgeTopic,
  ScheduleStore,
  ScheduledJob,
  ContextStore,
  DailyContext,
  AuditStore,
  AuditEntry,
  AuditFilter,
  ToolContextStore,
  ToolCallRecord,
  ToolResultRecord,
  ToolContextRecord,
} from './store.js';

export type {
  AgentContext,
  ResourceLimits,
  RuntimeContext,
  ContextLoader,
  TenantAgentScope,
} from './context.js';
export { createTenantAgentScope, tenantAgentScopeKey } from './context.js';

export type {
  Adapter,
  MessageRouter,
  InboundMessage,
  OutboundMessage,
  OutboundArtifact,
  OutboundAttachment,
  OutboundChunk,
} from './adapter.js';

export type {
  Transport,
  EventTransport,
  DurableTransport,
  DeliveryControl,
  DeliveryGuarantee,
  TransportDescription,
  Subscription,
  RequestOptions,
} from './transport.js';
export { assertDurable } from './transport.js';

export type { AgentRegistry } from './registry.js';

export type {
  WorkflowStateStore,
  WorkflowCheckpoint,
} from './workflow-state.js';

export type {
  CostEvent,
  BudgetPolicy,
  BudgetScope,
  BudgetWindow,
  BudgetStatus,
  BudgetTracker,
  ModelUsage,
} from './budget.js';

export type {
  Goal,
  GoalChain,
  GoalStore,
} from './goal.js';
export { formatGoalChain } from './goal.js';

export type {
  StoreBackendType,
  StoreBackendInfo,
  DescribableStore,
} from './store-backend.js';

export type {
  NexoraExtension,
  ExtensionContext,
  ExtensionRegistry,
} from './extension.js';

export type {
  SessionEntry,
  SessionTreeNode,
  TreeConversationStore,
  AppendEntryInput,
} from './session-tree.js';

export type {
  TranscriptEntry,
  TranscriptEntryBase,
  UserTranscriptEntry,
  AssistantTranscriptEntry,
  SystemTranscriptEntry,
  AttachmentTranscriptEntry,
  SummaryTranscriptEntry,
  TranscriptUsage,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,
  AttachmentRefSource,
  Base64ImageSource,
  UrlImageSource,
  TranscriptStore,
  AttachmentRef,
} from './transcript.js';
