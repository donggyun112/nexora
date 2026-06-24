/**
 * Background subagent registry + control tools.
 *
 * A caller-owned background subagent is a child AgentRuntime the parent agent
 * launches via `delegate({ waitForResult: 'async' })`. The child is pumped on a
 * detached loop; its eventual result is folded back into the parent's own turn
 * through `ctx.steerSelf` (or, if the parent turn already ended, delivered as a
 * new turn by the host). The parent keeps the leash: this registry tracks each
 * job so the parent can list running children (`check_subagents`) and cancel one
 * (`cancel_subagent`).
 *
 * Distinct from `dispatch` (autonomous peer-to-peer) — here the child is owned by
 * the caller, not a self-running peer. See the delegation-primitives ADR.
 */

import type { AgentRuntime, ToolContext, ToolDefinition, ToolResult } from '@dongkseo/contracts';
import { textResult, errorResult } from '@dongkseo/contracts';

export type BackgroundJobStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface BackgroundJob {
  jobId: string;
  childName: string;
  capability: string;
  status: BackgroundJobStatus;
  startedAt: number;
  settledAt?: number;
  /** Live child runtime — present only while running, cleared on settle. */
  runtime: AgentRuntime | null;
}

export interface BackgroundJobSnapshot {
  jobId: string;
  childName: string;
  capability: string;
  status: BackgroundJobStatus;
  startedAt: number;
  settledAt?: number;
}

/**
 * Tracks background subagent jobs for one parent agent runtime. A delegate tool
 * and its companion control tools (`check_subagents`, `cancel_subagent`) share a
 * single instance so the parent can see and steer the children it launched.
 */
export class BackgroundJobRegistry {
  private readonly jobs = new Map<string, BackgroundJob>();

  /**
   * @param maxSettledRetained Cap on retained settled (done/error/cancelled)
   *   jobs. Once exceeded, the oldest-settled jobs are evicted so the map and
   *   `check_subagents` output don't grow without bound over a long-lived parent.
   *   Running jobs are never evicted. Default 50.
   */
  constructor(private readonly maxSettledRetained = 50) {}

  register(job: {
    jobId: string;
    childName: string;
    capability: string;
    runtime: AgentRuntime;
    startedAt: number;
  }): void {
    this.jobs.set(job.jobId, {
      jobId: job.jobId,
      childName: job.childName,
      capability: job.capability,
      status: 'running',
      startedAt: job.startedAt,
      runtime: job.runtime,
    });
  }

  settle(jobId: string, status: Exclude<BackgroundJobStatus, 'running'>, settledAt: number): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running') return;
    job.status = status;
    job.settledAt = settledAt;
    job.runtime = null;
    this.pruneSettled();
  }

  /**
   * Abort a running job's child runtime and mark it cancelled. Returns false if
   * the job is unknown or already settled. Marking the status here (not waiting
   * for the detached pump to unwind) makes settle() a no-op for this job and
   * tells the pump to suppress delivery of the aborted child's partial output.
   */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running' || !job.runtime) return false;
    const runtime = job.runtime;
    job.status = 'cancelled';
    job.settledAt = Date.now();
    job.runtime = null;
    runtime.abort();
    this.pruneSettled();
    return true;
  }

  /** Evict oldest-settled jobs beyond the retention cap. Running jobs are kept. */
  private pruneSettled(): void {
    const settled = Array.from(this.jobs.values())
      .filter((j) => j.status !== 'running')
      .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
    for (let i = 0; i < settled.length - this.maxSettledRetained; i++) {
      this.jobs.delete(settled[i]!.jobId);
    }
  }

  list(): BackgroundJobSnapshot[] {
    return Array.from(this.jobs.values())
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(({ runtime: _runtime, ...snap }) => snap);
  }

  get(jobId: string): BackgroundJob | null {
    return this.jobs.get(jobId) ?? null;
  }
}

export interface SubagentControlToolOptions {
  registry: BackgroundJobRegistry;
}

/**
 * `check_subagents` — list the background subagents this agent launched, with
 * their status. Lets the agent decide whether to wait, proceed, or cancel.
 */
export function createCheckSubagentsTool(options: SubagentControlToolOptions): ToolDefinition {
  return {
    name: 'check_subagents',
    description:
      'List background subagents you launched (via delegate with waitForResult:"async") ' +
      'and their status (running / done / error / cancelled).',
    parameters: { type: 'object', properties: {} } as unknown as Record<string, unknown>,
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    async execute(_callId: string, _rawInput: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const jobs = options.registry.list();
      if (jobs.length === 0) return textResult('No background subagents.');
      return textResult(JSON.stringify(jobs));
    },
  };
}

/**
 * `cancel_subagent` — abort a running background subagent by job id. The parent
 * holds this leash; cancelling stops the child's runtime.
 */
export function createCancelSubagentTool(options: SubagentControlToolOptions): ToolDefinition {
  return {
    name: 'cancel_subagent',
    description: 'Abort a running background subagent by its job id (from check_subagents).',
    parameters: {
      type: 'object',
      required: ['job_id'],
      properties: {
        job_id: { type: 'string', description: 'Job id returned when the subagent was launched.' },
      },
    } as unknown as Record<string, unknown>,
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: true,
    async execute(_callId: string, rawInput: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const jobId = (rawInput as { job_id?: unknown })?.job_id;
      if (typeof jobId !== 'string' || !jobId.trim()) {
        return errorResult('job_id is required');
      }
      const ok = options.registry.cancel(jobId.trim());
      return ok
        ? textResult(`Cancelled subagent job ${jobId.trim()}.`)
        : errorResult(`No running subagent with job id ${jobId.trim()}.`);
    },
  };
}
