import type {
  AgentInput,
  AgentLogger,
  LLMProvider,
  RuntimeInputAdmission,
  ToolExecutor,
} from './agent.js';

/** Context available while an execution-scoped orchestrator session is opened. */
export interface RuntimeOrchestratorContext {
  input: AgentInput;
  signal: AbortSignal;
  logger: AgentLogger;
  /** Stable identity of the unwrapped model/provider configuration. */
  modelIdentity?: unknown;
}

/**
 * Execution-scoped adapters owned by an optional runtime orchestrator.
 *
 * The harness deliberately knows nothing about leases, ledgers, remote workers,
 * or replay policy. An orchestrator can add those semantics by decorating the
 * model and tool boundaries for one execution and releasing them in close().
 */
export interface RuntimeOrchestrationSession {
  wrapLLM(inner: LLMProvider): LLMProvider;
  wrapTools(inner: ToolExecutor): ToolExecutor;
  /**
   * Optional ordered ingress queue owned by this orchestration session.
   * When exposed, open() must submit the initial non-resume AgentInput because
   * planners stop appending AgentInput directly and consume this boundary only.
   */
  inputs?: RuntimeInputAdmission;
  close(): Promise<void>;
}

/** Optional plug-in for coordinating an execution. No orchestrator means direct execution. */
export interface RuntimeOrchestrator {
  open(context: RuntimeOrchestratorContext): Promise<RuntimeOrchestrationSession>;
}

/**
 * Control-plane failure that must escape the agent event stream.
 *
 * Implementations use this for conditions that require the caller to retry,
 * reconcile, or move execution ownership instead of presenting a normal agent
 * error to the model/user.
 */
export class OrchestrationControlError extends Error {}
