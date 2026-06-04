import { describe, expect, it, vi } from 'vitest';
import type {
  NexoraOracle,
  OracleContext,
  Worker,
  WorkerInvocationRequest,
} from '@nexora/contracts';
import {
  FleetCoordinator,
  HttpWorkerInvoker,
  InMemoryWorkerRegistry,
  NoWorkerForCapabilityError,
  OracleRejectedSyscallError,
  selectWorker,
} from '../index.js';

const context: OracleContext = {
  tenantId: 'tenant-a',
  conversationId: 'conversation-a',
  traceId: 'trace-a',
  spanId: 'span-a',
};

function worker(id: string, overrides: Partial<Worker> = {}): Worker {
  const now = new Date('2026-06-02T00:00:00.000Z');
  return {
    id,
    adapter: 'http',
    provides: ['marketing.long-form-content@v1'],
    endpoint: { type: 'http', url: `https://workers.test/${id}` },
    health: 'healthy',
    version: '0.1.0',
    startedAt: now,
    lastHeartbeat: now,
    inFlight: 0,
    ...overrides,
  };
}

function submitResult(workerId: string) {
  return {
    type: 'submit' as const,
    contract: 'submit_content',
    output: { workerId },
  };
}

describe('InMemoryWorkerRegistry', () => {
  it('registers, heartbeats, and finds workers by capability', async () => {
    const registry = new InMemoryWorkerRegistry();

    await registry.register({
      id: 'writer-1',
      adapter: 'http',
      provides: ['marketing.long-form-content@v1'],
      endpoint: { type: 'http', url: 'https://workers.test/writer-1' },
      version: '0.1.0',
    });

    const heartbeat = await registry.heartbeat({
      workerId: 'writer-1',
      health: 'degraded',
      inFlight: 3,
      version: '0.1.1',
    });

    expect(heartbeat?.health).toBe('degraded');
    expect(heartbeat?.inFlight).toBe(3);
    expect(heartbeat?.version).toBe('0.1.1');
    expect(await registry.findByCapability('marketing.long-form-content@v1')).toHaveLength(1);
    expect(await registry.findByCapability('missing')).toHaveLength(0);
  });

  it('returns null for heartbeat from an unknown worker', async () => {
    const registry = new InMemoryWorkerRegistry();

    await expect(registry.heartbeat({ workerId: 'missing', health: 'healthy' })).resolves.toBeNull();
  });
});

describe('selectWorker', () => {
  it('prefers healthy workers and then lowest in-flight load', () => {
    const selected = selectWorker([
      worker('degraded-low', { health: 'degraded', inFlight: 0 }),
      worker('healthy-high', { health: 'healthy', inFlight: 9 }),
      worker('healthy-low', { health: 'healthy', inFlight: 1 }),
    ], { allowDegraded: true });

    expect(selected?.id).toBe('healthy-low');
  });

  it('skips degraded workers unless explicitly allowed', () => {
    expect(selectWorker([worker('a', { health: 'degraded' })])).toBeNull();
    expect(selectWorker([worker('a', { health: 'degraded' })], { allowDegraded: true })?.id).toBe('a');
  });
});

describe('FleetCoordinator', () => {
  it('dispatches a capability to the selected worker', async () => {
    const registry = new InMemoryWorkerRegistry();
    await registry.register({
      id: 'writer-1',
      adapter: 'http',
      provides: ['marketing.long-form-content@v1'],
      endpoint: { type: 'http', url: 'https://workers.test/writer-1' },
      version: '0.1.0',
    });

    const invoke = vi.fn(async (_worker: Worker, request: WorkerInvocationRequest) => ({
      type: 'submit' as const,
      contract: 'submit_content',
      output: { draft: request.input },
    }));

    const coordinator = new FleetCoordinator({
      registry,
      invoker: { invoke },
    });

    const result = await coordinator.dispatch({
      id: 'dispatch-1',
      capability: 'marketing.long-form-content@v1',
      input: { title: 'Nexora' },
      context,
    });

    expect(result.worker.id).toBe('writer-1');
    expect(result.result.type).toBe('submit');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('fails when no healthy worker provides the capability', async () => {
    const coordinator = new FleetCoordinator({
      registry: new InMemoryWorkerRegistry(),
      invoker: { invoke: vi.fn() },
    });

    await expect(coordinator.dispatch({
      id: 'dispatch-1',
      capability: 'missing',
      input: {},
      context,
    })).rejects.toBeInstanceOf(NoWorkerForCapabilityError);
  });

  it('lets the oracle deny submit results', async () => {
    const registry = new InMemoryWorkerRegistry();
    await registry.register({
      id: 'writer-1',
      adapter: 'http',
      provides: ['marketing.long-form-content@v1'],
      endpoint: { type: 'http', url: 'https://workers.test/writer-1' },
      version: '0.1.0',
    });

    const oracle: NexoraOracle = {
      async judge({ syscall }) {
        if (syscall.type === 'submit') {
          return { decision: 'deny', reason: 'missing required evidence' };
        }
        return { decision: 'allow' };
      },
    };

    const coordinator = new FleetCoordinator({
      registry,
      invoker: {
        async invoke() {
          return { type: 'submit', contract: 'submit_content', output: {} };
        },
      },
      oracle,
    });

    await expect(coordinator.dispatch({
      id: 'dispatch-1',
      capability: 'marketing.long-form-content@v1',
      input: {},
      context,
    })).rejects.toBeInstanceOf(OracleRejectedSyscallError);
  });

  it('passes selected worker identity to invocation and submit oracle context', async () => {
    const registry = new InMemoryWorkerRegistry();
    await registry.register({
      id: 'writer-1',
      adapter: 'http',
      provides: ['marketing.long-form-content@v1'],
      endpoint: { type: 'http', url: 'https://workers.test/writer-1' },
      version: '0.1.0',
    });

    let invocationContext: OracleContext | undefined;
    let submitContext: OracleContext | undefined;
    const oracle: NexoraOracle = {
      async judge({ context: judgedContext, syscall }) {
        if (syscall.type === 'submit') submitContext = judgedContext;
        return { decision: 'allow' };
      },
    };

    const coordinator = new FleetCoordinator({
      registry,
      invoker: {
        async invoke(_worker, request) {
          invocationContext = request.context;
          return { type: 'submit', contract: 'submit_content', output: {} };
        },
      },
      oracle,
    });

    await coordinator.dispatch({
      id: 'dispatch-1',
      capability: 'marketing.long-form-content@v1',
      input: {},
      context,
    });

    expect(invocationContext?.workerId).toBe('writer-1');
    expect(invocationContext?.capability).toBe('marketing.long-form-content@v1');
    expect(submitContext?.workerId).toBe('writer-1');
    expect(submitContext?.capability).toBe('marketing.long-form-content@v1');
  });

  it('announces a broadcast without invoking workers', async () => {
    const registry = new InMemoryWorkerRegistry();
    await registry.register({
      id: 'writer-1',
      adapter: 'http',
      provides: ['marketing.long-form-content@v1'],
      endpoint: { type: 'http', url: 'https://workers.test/writer-1' },
      version: '0.1.0',
    });
    await registry.register({
      id: 'writer-2',
      adapter: 'http',
      provides: ['marketing.long-form-content@v1'],
      endpoint: { type: 'http', url: 'https://workers.test/writer-2' },
      version: '0.1.0',
    });

    const invoke = vi.fn();
    const coordinator = new FleetCoordinator({
      registry,
      invoker: { invoke },
    });

    const result = await coordinator.broadcast({
      id: 'broadcast-1',
      mode: 'announce',
      capability: 'marketing.long-form-content@v1',
      input: { title: 'Nexora' },
      context,
    });

    expect(result.workers.map(w => w.id)).toEqual(['writer-1', 'writer-2']);
    expect(result.deliveries).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fans out work to every eligible worker with broadcast metadata', async () => {
    const registry = new InMemoryWorkerRegistry();
    for (const id of ['writer-1', 'writer-2']) {
      await registry.register({
        id,
        adapter: 'http',
        provides: ['marketing.long-form-content@v1'],
        endpoint: { type: 'http', url: `https://workers.test/${id}` },
        version: '0.1.0',
      });
    }

    const invoke = vi.fn(async (target: Worker, request: WorkerInvocationRequest) => ({
      type: 'submit' as const,
      contract: 'submit_content',
      output: { workerId: target.id, broadcast: request.broadcast },
    }));
    const coordinator = new FleetCoordinator({
      registry,
      invoker: { invoke },
    });

    const result = await coordinator.broadcast({
      id: 'broadcast-1',
      mode: 'fanout',
      capability: 'marketing.long-form-content@v1',
      input: { title: 'Nexora' },
      context,
      ttlMs: 1_000,
      idempotencyKey: 'brief-1',
    });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.deliveries).toHaveLength(2);
    expect(result.deliveries.every(d => d.result?.type === 'submit')).toBe(true);
    expect(result.deliveries[0]?.request?.broadcast).toEqual({
      broadcastId: 'broadcast-1',
      mode: 'fanout',
      recipientCount: 2,
      ttlMs: 1_000,
      quorum: undefined,
    });
  });

  it('passes each broadcast worker identity to submit oracle context', async () => {
    const registry = new InMemoryWorkerRegistry();
    for (const id of ['writer-1', 'writer-2']) {
      await registry.register({
        id,
        adapter: 'http',
        provides: ['marketing.long-form-content@v1'],
        endpoint: { type: 'http', url: `https://workers.test/${id}` },
        version: '0.1.0',
      });
    }

    const submitWorkerIds: string[] = [];
    const oracle: NexoraOracle = {
      async judge({ context: judgedContext, syscall }) {
        if (syscall.type === 'submit' && judgedContext.workerId) {
          submitWorkerIds.push(judgedContext.workerId);
        }
        return { decision: 'allow' };
      },
    };

    const coordinator = new FleetCoordinator({
      registry,
      invoker: {
        async invoke() {
          return { type: 'submit', contract: 'submit_content', output: {} };
        },
      },
      oracle,
    });

    await coordinator.broadcast({
      id: 'broadcast-1',
      mode: 'fanout',
      capability: 'marketing.long-form-content@v1',
      input: {},
      context,
    });

    expect(submitWorkerIds.sort()).toEqual(['writer-1', 'writer-2']);
  });

  it('records the first accepted submit as race winner', async () => {
    const registry = new InMemoryWorkerRegistry();
    for (const id of ['slow', 'fast']) {
      await registry.register({
        id,
        adapter: 'http',
        provides: ['marketing.long-form-content@v1'],
        endpoint: { type: 'http', url: `https://workers.test/${id}` },
        version: '0.1.0',
      });
    }

    const invoke = vi.fn(async (target: Worker) => {
      if (target.id === 'slow') {
        await Promise.resolve();
      }
      return {
        type: 'submit' as const,
        contract: 'submit_content',
        output: { workerId: target.id },
      };
    });
    const coordinator = new FleetCoordinator({
      registry,
      invoker: { invoke },
    });

    const result = await coordinator.broadcast({
      id: 'broadcast-1',
      mode: 'race',
      capability: 'marketing.long-form-content@v1',
      input: {},
      context,
    });

    expect(result.winner?.worker.id).toBe('fast');
    expect(result.deliveries.some(d => d.worker.id === 'fast')).toBe(true);
  });

  it('race broadcast returns after the first accepted submit without waiting for slow workers', async () => {
    const registry = new InMemoryWorkerRegistry();
    for (const id of ['slow', 'fast']) {
      await registry.register({
        id,
        adapter: 'http',
        provides: ['marketing.long-form-content@v1'],
        endpoint: { type: 'http', url: `https://workers.test/${id}` },
        version: '0.1.0',
      });
    }

    let slowResolved = false;
    let releaseSlow: (() => void) | undefined;
    const invoke = vi.fn(async (target: Worker) => {
      if (target.id === 'slow') {
        return new Promise<ReturnType<typeof submitResult>>(resolve => {
          releaseSlow = () => {
            slowResolved = true;
            resolve(submitResult(target.id));
          };
        });
      }
      return submitResult(target.id);
    });
    const coordinator = new FleetCoordinator({
      registry,
      invoker: { invoke },
    });

    const result = await coordinator.broadcast({
      id: 'broadcast-1',
      mode: 'race',
      capability: 'marketing.long-form-content@v1',
      input: {},
      context,
    });

    expect(result.winner?.worker.id).toBe('fast');
    expect(slowResolved).toBe(false);
    releaseSlow?.();
  });

  it('reports quorum status from accepted submit deliveries', async () => {
    const registry = new InMemoryWorkerRegistry();
    for (const id of ['a', 'b', 'c']) {
      await registry.register({
        id,
        adapter: 'http',
        provides: ['marketing.long-form-content@v1'],
        endpoint: { type: 'http', url: `https://workers.test/${id}` },
        version: '0.1.0',
      });
    }

    const invoke = vi.fn(async (target: Worker) => {
      if (target.id === 'c') {
        return { type: 'error' as const, message: 'not enough evidence', retryable: false };
      }
      return { type: 'submit' as const, contract: 'submit_content', output: { workerId: target.id } };
    });
    const coordinator = new FleetCoordinator({
      registry,
      invoker: { invoke },
    });

    const result = await coordinator.broadcast({
      id: 'broadcast-1',
      mode: 'quorum',
      quorum: 2,
      capability: 'marketing.long-form-content@v1',
      input: {},
      context,
    });

    expect(result.quorum).toEqual({ required: 2, accepted: 2, met: true });
  });

  it('aggregates oracle submit denials as delivery errors', async () => {
    const registry = new InMemoryWorkerRegistry();
    await registry.register({
      id: 'writer-1',
      adapter: 'http',
      provides: ['marketing.long-form-content@v1'],
      endpoint: { type: 'http', url: 'https://workers.test/writer-1' },
      version: '0.1.0',
    });

    const oracle: NexoraOracle = {
      async judge({ syscall }) {
        if (syscall.type === 'submit') {
          return { decision: 'deny', reason: 'missing required evidence' };
        }
        return { decision: 'allow' };
      },
    };
    const coordinator = new FleetCoordinator({
      registry,
      invoker: {
        async invoke() {
          return { type: 'submit', contract: 'submit_content', output: {} };
        },
      },
      oracle,
    });

    const result = await coordinator.broadcast({
      id: 'broadcast-1',
      mode: 'fanout',
      capability: 'marketing.long-form-content@v1',
      input: {},
      context,
    });

    expect(result.deliveries[0]?.error).toBeInstanceOf(OracleRejectedSyscallError);
    expect(result.deliveries[0]?.decisions).toEqual([
      { decision: 'deny', reason: 'missing required evidence' },
    ]);
  });
});

describe('HttpWorkerInvoker', () => {
  it('posts invocation requests to the worker endpoint', async () => {
    const fetch = vi.fn(async (_url, _init) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        return { type: 'submit', contract: 'submit_content', output: { ok: true } };
      },
      async text() {
        return '';
      },
    }));
    const invoker = new HttpWorkerInvoker({ fetch });

    const result = await invoker.invoke(worker('writer-1'), {
      id: 'dispatch-1',
      context,
      capability: 'marketing.long-form-content@v1',
      input: { title: 'Nexora' },
    });

    expect(result.type).toBe('submit');
    expect(fetch).toHaveBeenCalledWith(
      'https://workers.test/writer-1',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('marketing.long-form-content@v1'),
      }),
    );
  });

  it('rejects invalid worker responses', async () => {
    const invoker = new HttpWorkerInvoker({
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
          return { type: 'submit' };
        },
        async text() {
          return '';
        },
      }),
    });

    await expect(invoker.invoke(worker('writer-1'), {
      id: 'dispatch-1',
      context,
      capability: 'marketing.long-form-content@v1',
      input: {},
    })).rejects.toThrow(/missing contract/);
  });
});
