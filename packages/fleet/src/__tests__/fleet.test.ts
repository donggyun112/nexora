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
