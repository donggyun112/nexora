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
  Transport,
  MessageEnvelope,
  TopicString,
  AgentLogger,
} from '@nexora/contracts';
import { traceId as newTraceId, conversationId as newConversationId } from '@nexora/contracts';

export interface WorkflowEngineOptions {
  transport: Transport;
  /** 단계별 기본 timeout (ms, 기본 60000) */
  defaultStepTimeoutMs?: number;
  logger?: AgentLogger;
}

export interface WorkflowExecutionInput {
  /** 초기 입력 (template/static input에서 참조 가능, key='input') */
  input?: unknown;
  /** 테넌트 ID */
  tenantId?: string;
  /** trace ID (없으면 자동 생성) */
  traceId?: string;
  /** conversation ID (없으면 자동 생성) */
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
  private readonly transport: Transport;
  private readonly defaultStepTimeoutMs: number;
  private readonly logger: AgentLogger;

  constructor(options: WorkflowEngineOptions) {
    this.transport = options.transport;
    this.defaultStepTimeoutMs = options.defaultStepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.logger = options.logger ?? NOOP_LOGGER;
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

    const tenantId = input.tenantId ?? 'default';
    const traceId = input.traceId ?? newTraceId();
    const conversationId = input.conversationId ?? newConversationId();
    const stepResults = new Map<string, WorkflowStepResult>();
    const ordered: WorkflowStepResult[] = [];

    let currentStepId: string | null = workflow.steps[0].id;
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
        return {
          workflow: workflow.name,
          status: 'failed',
          steps: ordered,
          error: `step ${step.id} failed`,
        };
      }

      currentStepId = nextStepId(workflow, step, transition ?? { action: 'next' });
    }

    return { workflow: workflow.name, status: 'completed', steps: ordered };
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
