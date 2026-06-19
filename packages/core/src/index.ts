/**
 * @dongkseo/core — 에이전트 런타임 코어.
 *
 * LLM Provider, Tool Executor, Memory + Compaction, Middleware, AgentRunner.
 */

export * from './llm/index.js';
export {
  CoreToolExecutor,
  formatToolResult,
  coerceToolArgs,
} from './tool-executor.js';
export type {
  ToolExecutorOptions,
  BatchToolCall,
  BatchToolResult,
} from './tool-executor.js';

export { CoreMemoryProvider } from './memory.js';
export type { CoreMemoryProviderOptions } from './memory.js';

export {
  TwoStageCompactor,
  estimateTokens,
  estimateContextSize,
  shouldCompact,
  truncateLargeContent,
  compressToolOutputs,
  pruneOldToolOutputs,
  sanitizeToolPairs,
  sanitizeLLMToolPairs,
  findCutPoint,
} from './compaction.js';
export type {
  Compactor,
  CompactorOptions,
  CompactionResult,
} from './compaction.js';

export {
  MiddlewarePipeline,
  loggingMiddleware,
  toolFilterMiddleware,
} from './middleware.js';
export type {
  AgentMiddleware,
  BeforeExecutionContext,
  AfterExecutionContext,
  BeforeToolCallContext,
  AfterToolCallContext,
  BeforeLLMCallContext,
  AfterLLMCallContext,
  SessionEventContext,
  PromptBuildContext,
  CompactEventContext,
  BudgetExceededContext,
} from './middleware.js';

export { createIdleTimeout, IdleTimeoutError } from './idle-timeout.js';
export type { IdleTimeout } from './idle-timeout.js';

export { AgentRunner } from './runner.js';
export type { AgentRunnerOptions } from './runner.js';

export { bootstrapAgent } from './bootstrap.js';
export type { AgentBootstrapOptions, RunningAgent } from './bootstrap.js';

export { createSchemaValidator, SchemaValidationError } from './schema.js';

export { lintAgentCard, enforceLint } from './lint.js';
export type { LintResult } from './lint.js';

export { InMemoryBudgetTracker, estimateCostUsd } from './budget.js';

export { createBudgetMiddleware, BudgetExceededError } from './budget-middleware.js';
export type { BudgetMiddlewareOptions } from './budget-middleware.js';

export { InMemoryExtensionRegistry, loadExtensions, unloadExtensions } from './extension-loader.js';
export type { ExtensionLoaderOptions, ExtensionManifest } from './extension-loader.js';


export {
  ExecutionTracker,
  LearningEngine,
  SafeSkillWriter,
  ResultsLedger,
  createImprovementLoop,
  scanSkillContent,
  validateSkillFrontmatter,
} from './self-improve.js';
export type {
  ExecutionRecord,
  LearningOutcome,
  PerformanceSnapshot,
  LedgerEntry,
  LearningEngineOptions,
  ImprovementLoopOptions,
  SafeSkillWriterOptions,
} from './self-improve.js';

// --- lifted from in7-marketing-poc (generic runtime primitives) ---
export { KeyedSerializer } from './keyed-serializer.js';
export { RotatingKeyProvider } from './rotating-key-provider.js';
export { ThinkingLlmProvider, parseThinkingLevel } from './thinking-provider.js';
export type { ThinkingLevel } from './thinking-provider.js';
export {
  normalizePublicHttpUrl,
  isPublicHost,
  assertHostResolvesPublic,
  safeFetchImageBytes,
} from './url-safety.js';
export type { SafeFetchOptions, SafeFetchResult } from './url-safety.js';


// Multica `pi` protocol_family adapter (headless one-shot agent execution).
export {
  agentEventToPiWire,
  createPiMapState,
  drivePi,
} from './pi-headless.js';
export type {
  PiUsage,
  PiWireEvent,
  PiMapState,
  DrivePiOptions,
  DrivePiResult,
} from './pi-headless.js';
