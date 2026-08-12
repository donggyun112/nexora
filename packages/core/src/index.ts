// ─── Core: contracts 계약을 실행하는 에이전트 런타임 엔진 ──────────────────
//
// 섹션 맵 (에이전트용: 무엇이 어느 파일에 있는지 — 정확한 타입은 해당 파일을 signatures 모드로)
//   LLM Provider   ./llm (./llm/pi-ai, ./llm/fallback)   PiAiProvider, FallbackLLMProvider
//   Tool Executor  ./tool-executor   CoreToolExecutor, formatToolResult, coerceToolArgs
//                  ./durable-tool-executor   DurableToolExecutor
//                  ./durable-llm-provider    DurableLLMProvider
//   Memory         ./transcript-memory   TranscriptMemoryProvider
//   Compaction     ./compaction      TwoStageCompactor, estimateTokens, shouldCompact
//   Middleware     ./middleware      MiddlewarePipeline, loggingMiddleware, toolFilterMiddleware
//   Runner         ./runner          AgentRunner          ./bootstrap   bootstrapAgent, RunningAgent
//   Guards         ./idle-timeout createIdleTimeout · ./schema createSchemaValidator
//                  ./budget InMemoryBudgetTracker · ./budget-middleware createBudgetMiddleware
//                  ./lint lintAgentCard, enforceLint
//   Extension      ./extension-loader   loadExtensions, InMemoryExtensionRegistry
//   Self-improve   ./self-improve   createImprovementLoop, LearningEngine, SafeSkillWriter
//   Primitives     ./keyed-serializer · ./rotating-key-provider · ./thinking-provider
//                  ./url-safety   safeFetchImageBytes, assertHostResolvesPublic
//   pi (headless)  ./pi-headless drivePi, agentEventToPiWire · ./pi-models listAvailableModels
//
// 새 모듈을 export하면 여기 한 줄 추가. API 설명은 각 파일 TSDoc이 정본 — 위는 위치 안내만.

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
export {
  DurableToolExecutor,
  DurableExecutionError,
  IndeterminateEffectError,
  RunLeaseContendedError,
  EffectReplayMismatchError,
  InvalidDurableToolCallError,
} from './durable-tool-executor.js';
export type { DurableToolExecutorOptions } from './durable-tool-executor.js';
export { MemoryEffectLedger } from './memory-effect-ledger.js';
export { DurableLLMProvider } from './durable-llm-provider.js';
export type { DurableLLMProviderOptions } from './durable-llm-provider.js';

export { TranscriptMemoryProvider } from './transcript-memory.js';
export type { TranscriptMemoryProviderOptions } from './transcript-memory.js';
export { TranscriptRecorder } from './transcript-recorder.js';
export { toLLMMessages, llmContentToBlocks } from './transcript-mapping.js';

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

export { LocalExecutionHarness } from './execution-harness.js';
export type { LocalExecutionHarnessOptions, DurableExecutionOptions } from './execution-harness.js';
export { HostWorkspaceProvider } from './workspace-provider.js';
export type { HostWorkspaceProviderOptions } from './workspace-provider.js';
export { AsrtSandboxClient } from './asrt-sandbox-client.js';
export type { AsrtSandboxClientOptions } from './asrt-sandbox-client.js';
export { createSandboxProvider, SANDBOX_SECRET_DENYLIST, isSandboxSupported } from './sandbox-provider.js';
export type { SandboxProviderOptions } from './sandbox-provider.js';
export { LocalTarSnapshotBackend, NoopSnapshotBackend, fingerprintRoot } from './workspace-snapshot.js';
export { ContinuousWorkspaceProvider } from './continuous-workspace-provider.js';
export type {
  ResumableWorkspaceProvider,
  ContinuousWorkspaceProviderOptions,
} from './continuous-workspace-provider.js';

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

// Verification Loop (grader/judge) — wrap a runtime factory with a retry-on-fail grader.
export {
  createVerifiedRuntime,
  createRubricGrader,
  createLlmJudgeGrader,
} from './verification.js';
export type {
  Grader,
  GradeResult,
  LlmJudgeOptions,
  VerifiedRuntimeOptions,
} from './verification.js';

// --- lifted from in7-marketing-poc (generic runtime primitives) ---
export { KeyedSerializer } from './keyed-serializer.js';
export { RotatingKeyProvider } from './rotating-key-provider.js';
export { ThinkingLlmProvider, parseThinkingLevel, isTransientLlmError } from './thinking-provider.js';
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

// Multica `pi` protocol_family model discovery (`<cmd> --list-models`).
export { listAvailableModels } from './pi-models.js';
export type { ListAvailableModelsOptions } from './pi-models.js';
