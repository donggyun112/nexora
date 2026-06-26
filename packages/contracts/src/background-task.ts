/**
 * Tool-neutral background-task layer.
 *
 * Any tool that launches detached work registers it in a BackgroundTaskRegistry
 * shared with the parent runtime, so the parent can observe it (check_tasks) and
 * cancel it (cancel_task). The launching tool decides delivery: fold into the
 * live turn via ctx.steerSelf, or — once the turn ends — via ctx.deliverResult.
 *
 * `kind` names the launching tool family (e.g. 'subagent'); `label` is a
 * human-readable name shown in check_tasks. Nothing here is subagent-specific.
 */

export type BackgroundTaskStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface BackgroundTask {
  taskId: string;
  kind: string;
  label: string;
  status: BackgroundTaskStatus;
  startedAt: number;
  settledAt?: number;
  /** Live cancellation handle — present only while running, cleared on settle. */
  abort: (() => void) | null;
}

export interface BackgroundTaskSnapshot {
  taskId: string;
  kind: string;
  label: string;
  status: BackgroundTaskStatus;
  startedAt: number;
  settledAt?: number;
}

/** Settled result delivered after the parent turn ended (deliverResult sink). */
export interface BackgroundTaskResult {
  taskId: string;
  kind: string;
  label: string;
  content: string;
  isError: boolean;
}

/**
 * Per-parent-runtime registry of background tasks. Shared between the launching
 * tool(s) and the check_tasks / cancel_task control tools.
 */
export interface BackgroundTaskRegistry {
  register(task: { taskId: string; kind: string; label: string; startedAt: number; abort: () => void }): void;
  settle(taskId: string, status: Exclude<BackgroundTaskStatus, 'running'>, settledAt: number): void;
  cancel(taskId: string): boolean;
  list(): BackgroundTaskSnapshot[];
  get(taskId: string): BackgroundTask | null;
  /** Subscribe to terminal state transitions (settle/cancel). Returns an
   *  unsubscribe fn. Fires AFTER the task's status is updated; register does not fire. */
  subscribe(listener: (taskId: string, status: BackgroundTaskStatus) => void): () => void;
}

/**
 * In-memory BackgroundTaskRegistry. One instance per parent agent runtime.
 *
 * @param maxSettledRetained Cap on retained settled (done/error/cancelled) tasks.
 *   Once exceeded, the oldest-settled are evicted so the map and check_tasks
 *   output don't grow without bound. Running tasks are never evicted. Default 50.
 */
export class InMemoryBackgroundTaskRegistry implements BackgroundTaskRegistry {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly listeners = new Set<(taskId: string, status: BackgroundTaskStatus) => void>();

  constructor(private readonly maxSettledRetained = 50) {}

  register(task: { taskId: string; kind: string; label: string; startedAt: number; abort: () => void }): void {
    this.tasks.set(task.taskId, {
      taskId: task.taskId,
      kind: task.kind,
      label: task.label,
      status: 'running',
      startedAt: task.startedAt,
      abort: task.abort,
    });
  }

  settle(taskId: string, status: Exclude<BackgroundTaskStatus, 'running'>, settledAt: number): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return;
    task.status = status;
    task.settledAt = settledAt;
    task.abort = null;
    this.pruneSettled();
    this.notify(taskId, status);
  }

  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running' || !task.abort) return false;
    const abort = task.abort;
    task.status = 'cancelled';
    task.settledAt = Date.now();
    task.abort = null;
    abort();
    this.pruneSettled();
    this.notify(taskId, 'cancelled');
    return true;
  }

  private pruneSettled(): void {
    const settled = Array.from(this.tasks.values())
      .filter((t) => t.status !== 'running')
      .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
    for (let i = 0; i < settled.length - this.maxSettledRetained; i++) {
      this.tasks.delete(settled[i]!.taskId);
    }
  }

  list(): BackgroundTaskSnapshot[] {
    return Array.from(this.tasks.values())
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(({ abort: _abort, ...snap }) => snap);
  }

  get(taskId: string): BackgroundTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  subscribe(listener: (taskId: string, status: BackgroundTaskStatus) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(taskId: string, status: BackgroundTaskStatus): void {
    for (const listener of this.listeners) {
      try {
        listener(taskId, status);
      } catch {
        // Isolate a bad listener — it must not break settle/cancel.
      }
    }
  }
}
