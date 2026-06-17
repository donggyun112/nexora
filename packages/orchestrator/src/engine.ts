/**
 * WorkflowEngine — WorkflowContract 실행기.
 *
 * 책임:
 *   - 각 step의 topic을 발행 → 응답 대기 (request/reply)
 *   - onSuccess/onFailure transition 처리 (next/goto/end)
 *   - retry policy 적용
 *   - 단계별 + 워크플로우 전체 timeout
 *   - 단계 결과 history를 fromStep input 참조용으로 보존
 *
 * 에이전트는 워크플로우를 모름 — orchestrator만 이 계약을 읽고 실행한다.
 */

import type {
  WorkflowContract,
  WorkflowStep,
  WorkflowStepInput,
  StepTransition,
  EventTransport,
  DurableTransport,
  MessageEnvelope,
  TopicString,
  AgentLogger,
  WorkflowStateStore,
  WorkflowCheckpoint,
} from '@dongkseo/contracts';
import {
  assertDurable,
  traceId as newTraceId,
  conversationId as newConversationId,
} from '@dongkseo/contracts';

export interface WorkflowEngineOptions {
  transport: EventTransport;
  /**
   * When true, constructor fails unless `transport` is durable. Use this for
   * production workflow runners where losing a step message is a correctness bug.
   */
  requireDurableTransport?: boolean;
  /** Default per-step timeout (ms). Default: 60000. */
  defaultStepTimeoutMs?: number;
  /**
   * Optional state store. If provided, the engine checkpoints after every
   * step transition so the workflow can be resumed after a crash via
   * `WorkflowEngine.resume(workflowId)`. Without a store, the engine runs
   * in-memory only and workflow state is lost on restart.
   */
  stateStore?: WorkflowStateStore;
  logger?: AgentLogger;
}

export interface ProductionWorkflowEngineOptions extends Omit<
  WorkflowEngineOptions,
  'transport' | 'requireDurableTransport'
> {
  transport: DurableTransport;
}

export interface WorkflowExecutionInput {
  /**
   * Unique identifier for THIS workflow run. Required when a state store is
   * configured — used as the checkpoint key. Optional otherwise; one is
   * auto-generated.
   */
  workflowId?: string;
  /** Initial input (referenced by `template` / `fromStep` inputs with key='input'). */
  input?: unknown;
  /** Tenant ID. Default: 'default'. */
  tenantId?: string;
  /** Trace ID (auto-generated if omitted). */
  traceId?: string;
  /** Conversation ID (auto-generated if omitted). */
  conversationId?: string;
}

export interface WorkflowStepResult {
  stepId: string;
  topic: string;
  payload: unknown;
  isError: boolean;
  attempts: number;
}

export interface WorkflowExecutionResult {
  workflow: string;
  status: 'completed' | 'failed';
  steps: WorkflowStepResult[];
  error?: string;
}

const DEFAULT_STEP_TIMEOUT_MS = 60_000;
const NOOP_LOGGER: AgentLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
};

export class WorkflowEngine {
  private readonly transport: EventTransport;
  private readonly defaultStepTimeoutMs: number;
  private readonly stateStore?: WorkflowStateStore;
  private readonly logger: AgentLogger;

  constructor(options: WorkflowEngineOptions) {
    this.transport = options.transport;
    this.defaultStepTimeoutMs = options.defaultStepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.stateStore = options.stateStore;
    this.logger = options.logger ?? NOOP_LOGGER;

    if (options.requireDurableTransport) {
      assertDurable(this.transport);
    }

    // If the transport is at-most-once, a workflow engine that promises
    // durability via stateStore is only half-durable — step delivery itself
    // can still be lost. Warn loudly so operators know to upgrade to a
    // DurableTransport for production. Wrapped in try/catch because
    // describe() is a newer interface method and older test stubs may not
    // implement it.
    if (this.stateStore) {
      try {
        const desc = this.transport.describe();
        if (!desc.durable) {
          this.logger.warn(
            `WorkflowEngine: state store configured but transport "${desc.kind}" is ${desc.deliveryGuarantee}. ` +
            `Workflow state will survive a crash, but individual step messages can still be lost. ` +
            `For production, use a DurableTransport (RedisStreamsTransport).`,
          );
        }
      } catch {
        // Transport doesn't implement describe() — skip warning for legacy stubs.
      }
    }
  }

  /**
   * Production preset: requires a DurableTransport at the type boundary and
   * rechecks it at runtime via transport.describe().
   */
  static production(options: ProductionWorkflowEngineOptions): WorkflowEngine {
    return new WorkflowEngine({
      ...options,
      requireDurableTransport: true,
    });
  }

  /**
   * 워크플로우 실행.
   * trigger는 무시하고 steps[0]부터 시작 (cron/topic 트리거는 외부에서 처리).
   */
  async run(
    workflow: WorkflowContract,
    input: WorkflowExecutionInput = {},
  ): Promise<WorkflowExecutionResult> {
    if (workflow.steps.length === 0) {
      return { workflow: workflow.name, status: 'completed', steps: [] };
    }

    const workflowId = input.workflowId ?? `${workflow.name}-${newConversationId()}`;
    const tenantId = input.tenantId ?? 'default';
    const traceId = input.traceId ?? newTraceId();
    const conversationId = input.conversationId ?? newConversationId();
    const stepResults = new Map<string, WorkflowStepResult>();
    const ordered: WorkflowStepResult[] = [];
    const startedAt = Date.now();

    let currentStepId: string | null = workflow.steps[0].id;

    // Initial checkpoint so that if we crash before the first step completes,
    // the workflow is at least discoverable via listRunning().
    await this.checkpoint({
      workflowId, workflowName: workflow.name, nextStepId: currentStepId,
      stepResults: {}, initialInput: input.input,
      tenantId, traceId, conversationId,
      startedAt, updatedAt: startedAt, status: 'running',
    });
    const stepById = new Map(workflow.steps.map(s => [s.id, s]));
    const visited = new Map<string, number>();
    const maxVisits = 50;

    const overallDeadline = workflow.timeoutMs
      ? Date.now() + workflow.timeoutMs
      : null;

    while (currentStepId !== null) {
      // overall timeout
      if (overallDeadline && Date.now() > overallDeadline) {
        return {
          workflow: workflow.name,
          status: 'failed',
          steps: ordered,
          error: `workflow timeout after ${workflow.timeoutMs}ms`,
        };
      }

      // loop guard
      const visits = (visited.get(currentStepId) ?? 0) + 1;
      if (visits > maxVisits) {
        return {
          workflow: workflow.name,
          status: 'failed',
          steps: ordered,
          error: `step ${currentStepId} visited > ${maxVisits} times (loop?)`,
        };
      }
      visited.set(currentStepId, visits);

      const step: WorkflowStep | undefined = stepById.get(currentStepId);
      if (!step) {
        return {
          workflow: workflow.name,
          status: 'failed',
          steps: ordered,
          error: `unknown step: ${currentStepId}`,
        };
      }

      const stepInput = resolveInput(step.input, {
        initial: input.input,
        results: stepResults,
      });

      this.logger.info(`workflow.${workflow.name} step ${step.id}`, {
        topic: step.topic,
      });

      const result = await this.runStep(step, stepInput, {
        tenantId,
        traceId,
        conversationId,
      });

      stepResults.set(step.id, result);
      // 같은 단계 재진입(goto) 시 ordered에 다시 push
      ordered.push(result);

      const transition: StepTransition | undefined = result.isError
        ? step.onFailure
        : step.onSuccess;

      if (result.isError && !transition) {
        // Terminal failure — record it in the checkpoint so operators can
        // inspect, then bubble up.
        await this.checkpoint({
          workflowId, workflowName: workflow.name, nextStepId: null,
          stepResults: toRecord(stepResults), initialInput: input.input,
          tenantId, traceId, conversationId,
          startedAt, updatedAt: Date.now(),
          status: 'failed', error: `step ${step.id} failed`,
        });
        return {
          workflow: workflow.name,
          status: 'failed',
          steps: ordered,
          error: `step ${step.id} failed`,
        };
      }

      currentStepId = nextStepId(workflow, step, transition ?? { action: 'next' });

      // Checkpoint after every successful transition so a crash here leaves
      // a resumable state pointing at the NEXT step, not the one we just ran.
      await this.checkpoint({
        workflowId, workflowName: workflow.name, nextStepId: currentStepId,
        stepResults: toRecord(stepResults), initialInput: input.input,
        tenantId, traceId, conversationId,
        startedAt, updatedAt: Date.now(), status: currentStepId ? 'running' : 'completed',
      });
    }

    // Successful completion — delete the checkpoint so finished workflows
    // don't linger in listRunning().
    if (this.stateStore) {
      try { await this.stateStore.delete(workflowId); } catch { /* best effort */ }
    }

    return { workflow: workflow.name, status: 'completed', steps: ordered };
  }

  /**
   * Resume a workflow from its last checkpoint. Throws if no state store is
   * configured or if the workflowId is not found.
   */
  async resume(
    workflow: WorkflowContract,
    workflowId: string,
  ): Promise<WorkflowExecutionResult> {
    if (!this.stateStore) {
      throw new Error('Cannot resume: WorkflowEngine constructed without a stateStore');
    }
    const checkpoint = await this.stateStore.load(workflowId);
    if (!checkpoint) {
      throw new Error(`No checkpoint found for workflowId "${workflowId}"`);
    }
    if (checkpoint.status !== 'running') {
      throw new Error(
        `Cannot resume workflow "${workflowId}" with status "${checkpoint.status}". ` +
        `Only 'running' workflows can be resumed.`,
      );
    }
    if (!checkpoint.nextStepId) {
      throw new Error(`Checkpoint for "${workflowId}" has no nextStepId`);
    }

    // We run a variant of the main loop starting from the checkpointed step.
    return this.runFrom(workflow, checkpoint);
  }

  /**
   * Shared loop body used by run() and resume(). Not exposed publicly — the
   * difference between fresh runs and resumes is captured in the initial
   * state passed in.
   */
  private async runFrom(
    workflow: WorkflowContract,
    checkpoint: WorkflowCheckpoint,
  ): Promise<WorkflowExecutionResult> {
    const stepResults = new Map<string, WorkflowStepResult>();
    for (const [id, value] of Object.entries(checkpoint.stepResults)) {
      // Reconstruct prior step results from the opaque blob. We trust the
      // store to have preserved them correctly; if deserialization fails
      // downstream (e.g. fromStep path), the next step will see undefined.
      stepResults.set(id, value as WorkflowStepResult);
    }
    const ordered: WorkflowStepResult[] = [...stepResults.values()];

    let currentStepId: string | null = checkpoint.nextStepId;
    const stepById = new Map(workflow.steps.map(s => [s.id, s]));
    const visited = new Map<string, number>();
    const maxVisits = 50;

    const overallDeadline = workflow.timeoutMs
      ? checkpoint.startedAt + workflow.timeoutMs
      : null;

    while (currentStepId !== null) {
      if (overallDeadline && Date.now() > overallDeadline) {
        return {
          workflow: workflow.name, status: 'failed', steps: ordered,
          error: `workflow timeout after ${workflow.timeoutMs}ms`,
        };
      }

      const visits = (visited.get(currentStepId) ?? 0) + 1;
      if (visits > maxVisits) {
        return {
          workflow: workflow.name, status: 'failed', steps: ordered,
          error: `step ${currentStepId} visited > ${maxVisits} times (loop?)`,
        };
      }
      visited.set(currentStepId, visits);

      const step = stepById.get(currentStepId);
      if (!step) {
        return {
          workflow: workflow.name, status: 'failed', steps: ordered,
          error: `unknown step: ${currentStepId}`,
        };
      }

      const stepInput = resolveInput(step.input, {
        initial: checkpoint.initialInput,
        results: stepResults,
      });

      const result = await this.runStep(step, stepInput, {
        tenantId: checkpoint.tenantId,
        traceId: checkpoint.traceId,
        conversationId: checkpoint.conversationId,
      });

      stepResults.set(step.id, result);
      ordered.push(result);

      const transition: StepTransition | undefined = result.isError ? step.onFailure : step.onSuccess;
      if (result.isError && !transition) {
        await this.checkpoint({
          ...checkpoint, nextStepId: null,
          stepResults: toRecord(stepResults),
          updatedAt: Date.now(), status: 'failed',
          error: `step ${step.id} failed`,
        });
        return {
          workflow: workflow.name, status: 'failed', steps: ordered,
          error: `step ${step.id} failed`,
        };
      }
      currentStepId = nextStepId(workflow, step, transition ?? { action: 'next' });
      await this.checkpoint({
        ...checkpoint, nextStepId: currentStepId,
        stepResults: toRecord(stepResults),
        updatedAt: Date.now(),
        status: currentStepId ? 'running' : 'completed',
      });
    }

    if (this.stateStore) {
      try { await this.stateStore.delete(checkpoint.workflowId); } catch { /* best effort */ }
    }
    return { workflow: workflow.name, status: 'completed', steps: ordered };
  }

  /** Persist a checkpoint if a state store is configured. No-op otherwise. */
  private async checkpoint(cp: WorkflowCheckpoint): Promise<void> {
    if (!this.stateStore) return;
    try {
      await this.stateStore.save(cp);
    } catch (err) {
      this.logger.warn(`workflow checkpoint save failed`, { workflowId: cp.workflowId, err: String(err) });
    }
  }

  private async runStep(
    step: WorkflowStep,
    payload: unknown,
    ctx: { tenantId: string; traceId: string; conversationId: string },
  ): Promise<WorkflowStepResult> {
    const maxAttempts = Math.max(step.retry?.maxAttempts ?? 1, 1);
    const backoffMs = step.retry?.backoffMs ?? 0;
    const timeoutMs = step.timeoutMs ?? this.defaultStepTimeoutMs;

    let lastError: Error | null = null;
    let lastErrorPayload: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const reply: MessageEnvelope = await this.transport.request(
          step.topic as TopicString,
          payload,
          {
            timeoutMs,
            traceId: ctx.traceId,
            conversationId: ctx.conversationId,
            tenantId: ctx.tenantId,
          },
        );

        const isError = isErrorPayload(reply.payload);

        // Logical errors (agent returned { error }) must also retry until maxAttempts.
        // Otherwise the first agent failure goes straight to onFailure, bypassing the retry policy.
        if (isError && attempt < maxAttempts) {
          lastErrorPayload = reply.payload;
          this.logger.warn(`workflow step ${step.id} attempt ${attempt} returned error`, {
            payload: reply.payload,
          });
          if (backoffMs > 0) {
            await new Promise(r => setTimeout(r, backoffMs * attempt));
          }
          continue;
        }

        return {
          stepId: step.id,
          topic: step.topic,
          payload: reply.payload,
          isError,
          attempts: attempt,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(`workflow step ${step.id} attempt ${attempt} failed`, {
          message: lastError.message,
        });
        if (attempt < maxAttempts && backoffMs > 0) {
          await new Promise(r => setTimeout(r, backoffMs * attempt));
        }
      }
    }

    // Exhausted retries: return the last error (transport throw OR error payload).
    if (lastError) {
      return {
        stepId: step.id,
        topic: step.topic,
        payload: { error: lastError.message },
        isError: true,
        attempts: maxAttempts,
      };
    }

    return {
      stepId: step.id,
      topic: step.topic,
      payload: lastErrorPayload ?? { error: 'unknown error' },
      isError: true,
      attempts: maxAttempts,
    };
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function nextStepId(
  workflow: WorkflowContract,
  current: WorkflowStep,
  transition: StepTransition,
): string | null {
  if (transition.action === 'end') return null;
  if (transition.action === 'goto') return transition.stepId;

  // next: 다음 단계 (배열 순서)
  const idx = workflow.steps.findIndex(s => s.id === current.id);
  if (idx === -1 || idx === workflow.steps.length - 1) return null;
  return workflow.steps[idx + 1].id;
}

function isErrorPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  return typeof (payload as { error?: unknown }).error === 'string';
}

function resolveInput(
  input: WorkflowStepInput | undefined,
  ctx: { initial: unknown; results: Map<string, WorkflowStepResult> },
): unknown {
  if (!input) return ctx.initial;

  if (input.type === 'static') return input.data;

  if (input.type === 'fromStep') {
    const result = ctx.results.get(input.stepId);
    if (!result) return null;
    return input.path ? extractPath(result.payload, input.path) : result.payload;
  }

  if (input.type === 'template') {
    return renderTemplate(input.template, {
      input: ctx.initial,
      steps: Object.fromEntries(
        Array.from(ctx.results.entries()).map(([id, r]) => [id, r.payload]),
      ),
    });
  }

  return ctx.initial;
}

/** {{path.to.value}} 패턴을 컨텍스트에서 치환 */
function renderTemplate(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path: string) => {
    const value = extractPath(ctx, path.trim());
    return value === undefined || value === null ? '' : String(value);
  });
}

function extractPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Convert the Map<stepId, result> into a plain object for serialization. */
function toRecord(map: Map<string, WorkflowStepResult>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of map) out[k] = v;
  return out;
}
