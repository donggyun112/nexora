import type {
  CapabilityRef,
  NexoraOracle,
  OracleContext,
  OracleDecision,
  PolicySnapshot,
  RuntimeState,
  Worker,
  WorkerHeartbeat,
  WorkerInvocationRequest,
  WorkerInvocationResult,
  WorkerInvoker,
  WorkerRegistration,
  WorkerRegistry,
} from '@nexora/contracts';

export type {
  Worker,
  WorkerHeartbeat,
  WorkerInvocationRequest,
  WorkerInvocationResult,
  WorkerInvoker,
  WorkerRegistration,
  WorkerRegistry,
} from '@nexora/contracts';

export class InMemoryWorkerRegistry implements WorkerRegistry {
  private readonly workers = new Map<string, Worker>();

  async register(registration: WorkerRegistration): Promise<Worker> {
    const now = new Date();
    const existing = this.workers.get(registration.id);
    const worker: Worker = {
      id: registration.id,
      adapter: registration.adapter,
      provides: [...registration.provides],
      endpoint: registration.endpoint,
      health: existing?.health ?? 'healthy',
      version: registration.version,
      startedAt: existing?.startedAt ?? now,
      lastHeartbeat: now,
      inFlight: existing?.inFlight ?? 0,
      metadata: registration.metadata,
    };
    this.workers.set(worker.id, worker);
    return worker;
  }

  async heartbeat(heartbeat: WorkerHeartbeat): Promise<Worker | null> {
    const worker = this.workers.get(heartbeat.workerId);
    if (!worker) return null;

    const updated: Worker = {
      ...worker,
      health: heartbeat.health,
      version: heartbeat.version ?? worker.version,
      inFlight: heartbeat.inFlight ?? worker.inFlight,
      lastHeartbeat: heartbeat.observedAt ?? new Date(),
      metadata: heartbeat.metadata ?? worker.metadata,
    };
    this.workers.set(updated.id, updated);
    return updated;
  }

  async unregister(workerId: string): Promise<void> {
    this.workers.delete(workerId);
  }

  async get(workerId: string): Promise<Worker | null> {
    return this.workers.get(workerId) ?? null;
  }

  async list(): Promise<Worker[]> {
    return Array.from(this.workers.values());
  }

  async findByCapability(capability: CapabilityRef): Promise<Worker[]> {
    return Array.from(this.workers.values()).filter(worker =>
      worker.provides.includes(capability),
    );
  }
}

export interface WorkerSelectionOptions {
  allowDegraded?: boolean;
}

export function selectWorker(
  workers: Worker[],
  options: WorkerSelectionOptions = {},
): Worker | null {
  const eligible = workers.filter(worker =>
    worker.health === 'healthy' || (options.allowDegraded && worker.health === 'degraded'),
  );

  eligible.sort((a, b) => {
    const healthRank = rankHealth(a.health) - rankHealth(b.health);
    if (healthRank !== 0) return healthRank;
    const loadRank = a.inFlight - b.inFlight;
    if (loadRank !== 0) return loadRank;
    return a.id.localeCompare(b.id);
  });

  return eligible[0] ?? null;
}

function rankHealth(health: Worker['health']): number {
  if (health === 'healthy') return 0;
  if (health === 'degraded') return 1;
  return 2;
}

export interface FleetCoordinatorOptions {
  registry: WorkerRegistry;
  invoker: WorkerInvoker;
  oracle?: NexoraOracle;
  policy?: PolicySnapshot;
  selection?: WorkerSelectionOptions;
}

export interface FleetDispatchInput {
  id: string;
  capability: CapabilityRef;
  input: unknown;
  context: OracleContext;
  timeoutMs?: number;
  idempotencyKey?: string;
  state?: RuntimeState;
  metadata?: Record<string, unknown>;
}

export interface FleetDispatchResult {
  worker: Worker;
  request: WorkerInvocationRequest;
  result: WorkerInvocationResult;
  decisions: OracleDecision[];
}

export class FleetCoordinator {
  constructor(private readonly options: FleetCoordinatorOptions) {}

  async dispatch(input: FleetDispatchInput): Promise<FleetDispatchResult> {
    const decisions: OracleDecision[] = [];
    const policy = this.options.policy ?? {};
    const state = input.state ?? {};

    const dispatchDecision = await this.judge({
      context: input.context,
      state,
      syscall: {
        type: 'dispatch',
        capability: input.capability,
        input: input.input,
        timeoutMs: input.timeoutMs,
        idempotencyKey: input.idempotencyKey,
      },
      policy,
    });
    decisions.push(dispatchDecision);
    assertAllowed(dispatchDecision);

    const workers = await this.options.registry.findByCapability(input.capability);
    const worker = selectWorker(workers, this.options.selection);
    if (!worker) {
      throw new NoWorkerForCapabilityError(input.capability);
    }

    const request: WorkerInvocationRequest = {
      id: input.id,
      context: input.context,
      capability: input.capability,
      input: input.input,
      timeoutMs: input.timeoutMs,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata,
    };

    const result = await this.options.invoker.invoke(worker, request);
    if (result.type === 'submit') {
      const submitDecision = await this.judge({
        context: input.context,
        state,
        syscall: {
          type: 'submit',
          capability: input.capability,
          contract: result.contract,
          output: result.output,
          evidence: result.evidence,
        },
        evidence: result.evidence,
        policy,
      });
      decisions.push(submitDecision);
      assertAllowed(submitDecision);
    }

    return { worker, request, result, decisions };
  }

  private async judge(input: Parameters<NexoraOracle['judge']>[0]): Promise<OracleDecision> {
    if (!this.options.oracle) return { decision: 'allow' };
    return this.options.oracle.judge(input);
  }
}

function assertAllowed(decision: OracleDecision): void {
  if (decision.decision === 'allow') return;
  throw new OracleRejectedSyscallError(decision);
}

export class NoWorkerForCapabilityError extends Error {
  constructor(readonly capability: CapabilityRef) {
    super(`No healthy worker provides capability "${capability}".`);
    this.name = 'NoWorkerForCapabilityError';
  }
}

export class OracleRejectedSyscallError extends Error {
  constructor(readonly decision: OracleDecision) {
    super(`Oracle rejected syscall with decision "${decision.decision}".`);
    this.name = 'OracleRejectedSyscallError';
  }
}

export interface HttpWorkerInvokerOptions {
  headers?: Record<string, string>;
  fetch?: HttpWorkerFetch;
}

export type HttpWorkerFetch = (
  input: string,
  init?: HttpWorkerFetchInit,
) => Promise<HttpWorkerFetchResponse>;

export interface HttpWorkerFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpWorkerFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export class HttpWorkerInvoker implements WorkerInvoker {
  constructor(private readonly options: HttpWorkerInvokerOptions = {}) {}

  async invoke(worker: Worker, request: WorkerInvocationRequest): Promise<WorkerInvocationResult> {
    if (worker.endpoint.type !== 'http') {
      throw new Error(`Worker "${worker.id}" endpoint is "${worker.endpoint.type}", expected "http".`);
    }

    const fetchImpl = this.options.fetch ?? getGlobalFetch();
    const fetchPromise = fetchImpl(worker.endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this.options.headers,
        ...worker.endpoint.headers,
      },
      body: JSON.stringify(request),
    });
    const timers = getGlobalTimers();
    let timeoutHandle: unknown;

    try {
      const timeoutMs = request.timeoutMs;
      const response = timeoutMs
        ? await Promise.race([
          fetchPromise,
          new Promise<never>((_, reject) => {
            timeoutHandle = timers.setTimeout(() => {
              reject(new Error(`HTTP worker "${worker.id}" timed out after ${timeoutMs}ms.`));
            }, timeoutMs);
          }),
        ])
        : await fetchPromise;

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `HTTP worker "${worker.id}" returned ${response.status} ${response.statusText}: ${body}`,
        );
      }

      return parseWorkerInvocationResult(await response.json());
    } finally {
      if (timeoutHandle) timers.clearTimeout(timeoutHandle);
    }
  }
}

function getGlobalFetch(): HttpWorkerFetch {
  const candidate = (globalThis as unknown as { fetch?: HttpWorkerFetch }).fetch;
  if (!candidate) {
    throw new Error('No fetch implementation available. Pass HttpWorkerInvoker({ fetch }).');
  }
  return candidate;
}

function getGlobalTimers(): {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
} {
  return globalThis as unknown as {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

function parseWorkerInvocationResult(value: unknown): WorkerInvocationResult {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('HTTP worker returned an invalid invocation result.');
  }

  if (value.type === 'submit') {
    if (typeof value.contract !== 'string') {
      throw new Error('HTTP worker submit result is missing contract.');
    }
    return {
      type: 'submit',
      contract: value.contract,
      output: value.output,
      evidence: Array.isArray(value.evidence) ? value.evidence : undefined,
      metadata: isRecord(value.metadata) ? value.metadata : undefined,
    };
  }

  if (value.type === 'escalate') {
    if (typeof value.reason !== 'string') {
      throw new Error('HTTP worker escalation result is missing reason.');
    }
    return {
      type: 'escalate',
      reason: value.reason,
      target: isEscalationTarget(value.target) ? value.target : undefined,
      evidence: Array.isArray(value.evidence) ? value.evidence : undefined,
      metadata: isRecord(value.metadata) ? value.metadata : undefined,
    };
  }

  if (value.type === 'error') {
    if (typeof value.message !== 'string') {
      throw new Error('HTTP worker error result is missing message.');
    }
    return {
      type: 'error',
      message: value.message,
      retryable: typeof value.retryable === 'boolean' ? value.retryable : undefined,
      evidence: Array.isArray(value.evidence) ? value.evidence : undefined,
      metadata: isRecord(value.metadata) ? value.metadata : undefined,
    };
  }

  throw new Error(`HTTP worker returned unknown result type "${value.type}".`);
}

function isEscalationTarget(value: unknown): value is 'user' | 'supervisor' | 'operator' {
  return value === 'user' || value === 'supervisor' || value === 'operator';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
