/**
 * In-memory WorkflowStateStore — default implementation for dev/test.
 *
 * Production deployments should use a durable backend (file, Redis, Postgres)
 * so checkpoints survive a process restart. This implementation exists so
 * tests can exercise the checkpoint/resume code paths without a real store,
 * and so single-process demos can see the engine's state machine without
 * wiring anything extra.
 */

import type { WorkflowStateStore, WorkflowCheckpoint } from '@nexora/contracts';

export class InMemoryWorkflowStateStore implements WorkflowStateStore {
  private readonly checkpoints = new Map<string, WorkflowCheckpoint>();

  async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    // Store a structural clone so later mutations on the original don't
    // corrupt the saved state.
    this.checkpoints.set(checkpoint.workflowId, structuredClone(checkpoint));
  }

  async load(workflowId: string): Promise<WorkflowCheckpoint | null> {
    const cp = this.checkpoints.get(workflowId);
    return cp ? structuredClone(cp) : null;
  }

  async delete(workflowId: string): Promise<void> {
    this.checkpoints.delete(workflowId);
  }

  async listRunning(): Promise<WorkflowCheckpoint[]> {
    return Array.from(this.checkpoints.values())
      .filter(cp => cp.status === 'running')
      .map(cp => structuredClone(cp));
  }
}
