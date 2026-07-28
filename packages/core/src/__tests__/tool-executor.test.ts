import { describe, it, expect } from 'vitest';
import { CoreToolExecutor, formatToolResult } from '../tool-executor.js';
import type { ToolDefinition, ToolContext, ToolResult } from '@dongkseo/contracts';

const mockContext: ToolContext = {
  tenantId: 'test',
  workdir: '/tmp',
  secrets: { get: async () => undefined },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

function makeEcho(): ToolDefinition {
  return {
    name: 'echo',
    description: 'Echo input',
    parameters: { type: 'object', properties: { msg: { type: 'string' } } },
    execute: async (_id, input): Promise<ToolResult> => ({
      type: 'text',
      text: `echo: ${(input as { msg: string }).msg}`,
    }),
  };
}

function makeFailing(): ToolDefinition {
  return {
    name: 'fail',
    description: 'Always fails',
    parameters: { type: 'object', properties: {} },
    execute: async (): Promise<ToolResult> => {
      throw new Error('boom');
    },
  };
}

function makeSlow(
  ms: number,
  options: { name?: string; isConcurrencySafe?: boolean } = {},
): ToolDefinition {
  return {
    name: options.name ?? 'slow',
    description: 'Slow tool',
    parameters: { type: 'object', properties: {} },
    ...(options.isConcurrencySafe === undefined
      ? {}
      : { isConcurrencySafe: options.isConcurrencySafe }),
    execute: async (): Promise<ToolResult> => {
      await new Promise(r => setTimeout(r, ms));
      return { type: 'text', text: 'slow done' };
    },
  };
}

describe('CoreToolExecutor', () => {
  it('list returns registered tools', () => {
    const exec = new CoreToolExecutor({
      tools: [makeEcho(), makeFailing()],
      context: mockContext,
    });
    expect(exec.list()).toHaveLength(2);
    expect(exec.list().map(t => t.name)).toEqual(['echo', 'fail']);
  });

  it('execute returns text result', async () => {
    const exec = new CoreToolExecutor({ tools: [makeEcho()], context: mockContext });
    const result = await exec.execute('echo', 'call-1', { msg: 'hi' });
    expect(result).toEqual({ type: 'text', text: 'echo: hi' });
  });

  it('execute returns error for unknown tool', async () => {
    const exec = new CoreToolExecutor({ tools: [], context: mockContext });
    const result = await exec.execute('missing', 'call-1', {});
    expect(result).toEqual({ type: 'error', message: 'Unknown tool: missing' });
  });

  it('execute catches thrown errors', async () => {
    const exec = new CoreToolExecutor({ tools: [makeFailing()], context: mockContext });
    const result = await exec.execute('fail', 'call-1', {});
    expect(result).toEqual({ type: 'error', message: 'boom' });
  });

  it('execute does not run unavailable tools even when called by name', async () => {
    let ran = false;
    const gated: ToolDefinition = {
      name: 'gated',
      description: 'Gated tool',
      parameters: { type: 'object', properties: {} },
      checkAvailability: () => false,
      execute: async () => {
        ran = true;
        return { type: 'text', text: 'should not run' };
      },
    };
    const exec = new CoreToolExecutor({ tools: [gated], context: mockContext });

    expect(exec.list()).toEqual([]);
    expect(exec.get('gated')).toBeUndefined();
    expect(exec.has('gated')).toBe(false);
    const result = await exec.execute('gated', 'call-1', {});

    expect(ran).toBe(false);
    expect(result).toEqual({ type: 'error', message: 'Tool unavailable: gated' });
  });

  it('executeBatch returns ordered results and isolates failures', async () => {
    const exec = new CoreToolExecutor({
      tools: [makeEcho(), makeFailing(), makeSlow(50)],
      context: mockContext,
    });

    const start = Date.now();
    const results = await exec.executeBatch([
      { callId: 'a', name: 'echo', input: { msg: 'first' } },
      { callId: 'b', name: 'fail', input: {} },
      { callId: 'c', name: 'slow', input: {} },
    ]);
    const elapsed = Date.now() - start;

    // 병렬 실행이면 ~50ms, 순차면 ~150ms+
    expect(elapsed).toBeLessThan(120);

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ callId: 'a', isError: false });
    expect(results[1]).toMatchObject({ callId: 'b', isError: true });
    expect(results[2]).toMatchObject({ callId: 'c', isError: false });
  });

  it('executeBatch runs unsafe tools sequentially by default', async () => {
    let active = 0;
    let peak = 0;
    const tracked = (name: string): ToolDefinition => ({
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(r => setTimeout(r, 20));
        active--;
        return { type: 'text', text: name };
      },
    });
    const exec = new CoreToolExecutor({
      tools: [tracked('a'), tracked('b')],
      context: mockContext,
    });

    await exec.executeBatch([
      { callId: 'a', name: 'a', input: {} },
      { callId: 'b', name: 'b', input: {} },
    ]);

    expect(peak).toBe(1);
  });

  it('executeBatch parallelizes consecutive concurrency-safe tools', async () => {
    let active = 0;
    let peak = 0;
    const tracked = (name: string): ToolDefinition => ({
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
      isConcurrencySafe: true,
      execute: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(r => setTimeout(r, 20));
        active--;
        return { type: 'text', text: name };
      },
    });
    const exec = new CoreToolExecutor({
      tools: [tracked('a'), tracked('b')],
      context: mockContext,
    });

    await exec.executeBatch([
      { callId: 'a', name: 'a', input: {} },
      { callId: 'b', name: 'b', input: {} },
    ]);

    expect(peak).toBe(2);
  });

  it('executeBatch runs an exclusive suspending call first and skips the rest', async () => {
    const order: string[] = [];
    const write: ToolDefinition = {
      name: 'write',
      description: 'write',
      parameters: {},
      isConcurrencySafe: true,
      execute: async () => {
        order.push('write');
        return { type: 'text', text: 'written' };
      },
    };
    const approval: ToolDefinition = {
      name: 'approval',
      description: 'approval',
      parameters: {},
      isExclusive: true,
      execute: async () => {
        order.push('approval');
        return { type: 'suspend', pendingId: 'pending-1' };
      },
    };
    const exec = new CoreToolExecutor({
      tools: [write, approval],
      context: mockContext,
    });

    const results = await exec.executeBatch([
      { callId: 'write-1', name: 'write', input: {} },
      { callId: 'approval-1', name: 'approval', input: {} },
    ]);

    expect(order).toEqual(['approval']);
    expect(results).toEqual([{
      callId: 'approval-1',
      name: 'approval',
      result: { type: 'suspend', pendingId: 'pending-1' },
      isError: false,
    }]);
  });
});

describe('formatToolResult', () => {
  it('formats text result', () => {
    expect(formatToolResult({ type: 'text', text: 'hello' })).toBe('hello');
  });

  it('formats image placeholder', () => {
    expect(formatToolResult({ type: 'image', data: 'abc', mimeType: 'image/png' }))
      .toBe('[image: image/png]');
  });

  it('formats error', () => {
    expect(formatToolResult({ type: 'error', message: 'oops' })).toBe('[ERROR] oops');
  });
});
