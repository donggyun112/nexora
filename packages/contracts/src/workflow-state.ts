/**
 * Workflow state persistence contract.
 *
 * WorkflowEngine was originally in-memory only: if the process crashed
 * mid-workflow, everything after the last-returned step was lost. This
 * contract lets the engine checkpoint state between steps and resume
 * from the last checkpoint after a restart.
 *
 * Implementations live outside @dongkseo/contracts (in-memory in the
 * orchestrator package, file-based in @dongkseo/store-json, future
 * Redis/Postgres in their own packages).
 */

export interface WorkflowCheckpoint {
  /** Unique identifier for this workflow run. Must be supplied by the caller. */
  workflowId: string;
  /** The workflow contract's name (from WorkflowContract.name). */
  workflowName: string;
  /** Which step to execute next when resuming. */
  nextStepId: string | null;
  /** Results of completed steps, keyed by stepId. Opaque to the store. */
  stepResults: Record<string, unknown>;
  /** Initial trigger input, preserved for template expansion on resume. */
  initialInput: unknown;
  /** Tenant + trace metadata — preserved across resume so the trace stays intact. */
  tenantId: string;
  traceId: string;
  conversationId: string;
  /** Timestamps for debugging / cleanup. */
  startedAt: number;
  updatedAt: number;
  /** Status. 'running' is the normal state; terminal states are kept so operators can inspect. */
  status: 'running' | 'completed' | 'failed';
  /** Optional error message if status === 'failed'. */
  error?: string;
}

export interface WorkflowStateStore {
  /** Persist a checkpoint (insert or update by workflowId). */
  save(checkpoint: WorkflowCheckpoint): Promise<void>;

  /** Load the latest checkpoint for a workflowId. Returns null if never saved. */
  load(workflowId: string): Promise<WorkflowCheckpoint | null>;

  /** Delete a workflow's state (usually on successful completion). */
  delete(workflowId: string): Promise<void>;

  /**
   * List all checkpoints with `status === 'running'`. Used by the engine at
   * startup to find workflows that were mid-flight when the last process
   * crashed, so they can be resumed.
   */
  listRunning(): Promise<WorkflowCheckpoint[]>;
}
