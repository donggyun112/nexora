import { describe, expect, it } from 'vitest';
import type {
  AgentArchitecture,
  AgentEvent,
  AgentInput,
  RuntimeServices,
  ToolDefinition,
  ToolExecutor,
  ToolResult,
} from '@dongkseo/contracts';
import { EffectWriteFencedError } from '@dongkseo/contracts';
import {
  DurableToolExecutor,
  EffectReplayMismatchError,
  InvalidDurableToolCallError,
  IndeterminateEffectError,
} from '../durable-tool-executor.js';
import { LocalExecutionHarness } from '../execution-harness.js';
import { MemoryEffectLedger } from '../memory-effect-ledger.js';
import { MockLLMProvider } from './mock-llm.js';

function executor(
  execute: ToolExecutor['execute'],
  definitions: ToolDefinition[] = [],
): ToolExecutor {
  const byName = new Map(definitions.map(tool => [tool.name, tool]));
  return {
    execute,
    list: () => definitions.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    get: name => byName.get(name),
  };
}

describe('MemoryEffectLedger', () => {
  it('refuses a second owner while a lease is live', async () => {
    const ledger = new MemoryEffectLedger();

    expect(await ledger.acquire('run-1', 'worker-a', 60_000)).toBe(1);
    expect(await ledger.acquire('run-1', 'worker-b', 60_000)).toBe(0);
  });

  it('fences a previous owner after lease takeover', async () => {
    const ledger = new MemoryEffectLedger();
    const stale = await ledger.acquire('run-1', 'worker-a', 0);
    const current = await ledger.acquire('run-1', 'worker-b', 60_000);

    expect(current).toBeGreaterThan(stale);
    await expect(ledger.start('run-1', 'call-1', stale)).rejects.toBeInstanceOf(
      EffectWriteFencedError,
    );
  });
});

describe('DurableToolExecutor', () => {
  it('replays a committed result without running the tool again', async () => {
    const ledger = new MemoryEffectLedger();
    const token = await ledger.acquire('run-1', 'worker-a', 60_000);
    let calls = 0;
    const durable = new DurableToolExecutor({
      inner: executor(async () => {
        calls++;
        return { type: 'text', text: 'done' } satisfies ToolResult;
      }),
      ledger,
      runId: 'run-1',
      fencingToken: token,
    });

    const first = await durable.execute('write', 'call-1', { path: 'a.txt' });
    const replayed = await durable.execute('write', 'call-1', { path: 'a.txt' });

    expect(first).toEqual({ type: 'text', text: 'done' });
    expect(replayed).toEqual(first);
    expect(calls).toBe(1);
  });

  it('rejects a call id reused for different input', async () => {
    const ledger = new MemoryEffectLedger();
    const token = await ledger.acquire('run-1', 'worker-a', 60_000);
    const durable = new DurableToolExecutor({
      inner: executor(async () => ({ type: 'text', text: 'done' })),
      ledger,
      runId: 'run-1',
      fencingToken: token,
    });
    await durable.execute('write', 'call-1', { path: 'a.txt' });

    await expect(durable.execute('write', 'call-1', { path: 'b.txt' }))
      .rejects.toBeInstanceOf(EffectReplayMismatchError);
  });

  it('surfaces interrupted running intent instead of repeating the effect', async () => {
    const ledger = new MemoryEffectLedger();
    const token = await ledger.acquire('run-1', 'worker-a', 60_000);
    await ledger.start('run-1', 'call-1', token);
    let calls = 0;
    const durable = new DurableToolExecutor({
      inner: executor(async () => {
        calls++;
        return { type: 'text', text: 'unexpected' };
      }),
      ledger,
      runId: 'run-1',
      fencingToken: token,
    });

    await expect(durable.execute('write', 'call-1', {}))
      .rejects.toBeInstanceOf(IndeterminateEffectError);
    expect(calls).toBe(0);
  });

  it('leaves intent running when the executor throws', async () => {
    const ledger = new MemoryEffectLedger();
    const token = await ledger.acquire('run-1', 'worker-a', 60_000);
    const durable = new DurableToolExecutor({
      inner: executor(async () => { throw new Error('transport lost'); }),
      ledger,
      runId: 'run-1',
      fencingToken: token,
    });

    await expect(durable.execute('remote-write', 'call-1', {})).rejects.toThrow('transport lost');
    await expect(durable.execute('remote-write', 'call-1', {}))
      .rejects.toBeInstanceOf(IndeterminateEffectError);
  });

  it('runs a mixed-safety batch sequentially', async () => {
    const ledger = new MemoryEffectLedger();
    const token = await ledger.acquire('run-1', 'worker-a', 60_000);
    let active = 0;
    let peak = 0;
    const makeTool = (name: string, isConcurrencySafe: boolean): ToolDefinition => ({
      name,
      description: name,
      parameters: {},
      isConcurrencySafe,
      execute: async () => ({ type: 'text', text: name }),
    });
    const definitions = [makeTool('safe', true), makeTool('unsafe', false)];
    const durable = new DurableToolExecutor({
      inner: executor(async (_name) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active--;
        return { type: 'text', text: 'done' };
      }, definitions),
      ledger,
      runId: 'run-1',
      fencingToken: token,
    });

    await durable.executeBatch?.([
      { callId: 'call-1', name: 'safe', input: {} },
      { callId: 'call-2', name: 'unsafe', input: {} },
    ]);

    expect(peak).toBe(1);
  });

  it('rejects duplicate batch ids before any effect starts', async () => {
    const ledger = new MemoryEffectLedger();
    const token = await ledger.acquire('run-1', 'worker-a', 60_000);
    let calls = 0;
    const durable = new DurableToolExecutor({
      inner: executor(async () => {
        calls++;
        return { type: 'text', text: 'unexpected' };
      }),
      ledger,
      runId: 'run-1',
      fencingToken: token,
    });

    await expect(durable.executeBatch?.([
      { callId: 'same', name: 'a', input: {} },
      { callId: 'same', name: 'b', input: {} },
    ])).rejects.toBeInstanceOf(InvalidDurableToolCallError);
    expect(calls).toBe(0);
    expect(await ledger.read('run-1', 'agent:tool:same')).toEqual({ status: 'absent' });
  });
});

describe('LocalExecutionHarness durability', () => {
  it('replays the same tool effect across executions and releases the lease', async () => {
    const ledger = new MemoryEffectLedger();
    let calls = 0;
    const tools = executor(async () => {
      calls++;
      return { type: 'text', text: 'written' };
    });
    const architecture: AgentArchitecture = {
      name: 'one-effect',
      async *loop(services: RuntimeServices, _input: AgentInput): AsyncGenerator<AgentEvent> {
        const result = await services.tools.execute('write', 'call-1', { path: 'a.txt' });
        yield { type: 'tool_result', id: 'call-1', name: 'write', result, isError: false };
        yield { type: 'done', content: 'done', toolCalls: [] };
      },
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      const harness = new LocalExecutionHarness({
        architecture,
        llm: new MockLLMProvider([]),
        tools,
        durability: { ledger, runId: 'run-1' },
      });
      const events: AgentEvent[] = [];
      for await (const event of harness.execute({ prompt: 'go' })) events.push(event);
      expect(events.at(-1)?.type).toBe('done');
    }

    expect(calls).toBe(1);
  });

  it('does not turn an indeterminate effect into a normal error event', async () => {
    const ledger = new MemoryEffectLedger();
    const token = await ledger.acquire('run-1', 'crashed-worker', 0);
    await ledger.start('run-1', 'call-1', token);
    const architecture: AgentArchitecture = {
      name: 'one-effect',
      async *loop(services: RuntimeServices): AsyncGenerator<AgentEvent> {
        await services.tools.execute('write', 'call-1', {});
        yield { type: 'done', content: 'unexpected', toolCalls: [] };
      },
    };
    const harness = new LocalExecutionHarness({
      architecture,
      llm: new MockLLMProvider([]),
      tools: executor(async () => ({ type: 'text', text: 'unexpected' })),
      durability: { ledger, runId: 'run-1' },
    });

    const drain = async (): Promise<void> => {
      for await (const _event of harness.execute({ prompt: 'go' })) {
        // drain
      }
    };
    await expect(drain()).rejects.toBeInstanceOf(IndeterminateEffectError);
  });
});
