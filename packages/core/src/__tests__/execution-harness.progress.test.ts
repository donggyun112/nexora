import { describe, it, expect } from 'vitest';
import { LocalExecutionHarness } from '../execution-harness.js';
import { CoreToolExecutor } from '../tool-executor.js';
import type {
  AgentArchitecture, AgentEvent, RuntimeServices, ToolContext, LLMProvider,
} from '@dongkseo/contracts';

const baseCtx: ToolContext = {
  tenantId: 'default', workdir: '/tmp',
  secrets: { get: async () => undefined },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

const nullLLM = { complete: async () => ({ content: '', toolCalls: [] }) } as unknown as LLMProvider;

// Architecture that runs one tool (which emits progress mid-execution) then finishes.
function archCallingTool(): AgentArchitecture {
  return {
    name: 'probe',
    async *loop(services: RuntimeServices): AsyncGenerator<AgentEvent> {
      yield { type: 'tool_call', id: 'c1', name: 'emit', input: {} };
      const result = await services.tools.execute('emit', 'c1', {}, services.signal);
      yield { type: 'tool_result', id: 'c1', name: 'emit', result, isError: false };
      yield { type: 'done', content: 'ok', toolCalls: [] };
    },
  } as unknown as AgentArchitecture;
}

// Tool that emits two progress events while running, then returns.
function emittingTool(captured: { hadEmit?: boolean }) {
  return {
    name: 'emit',
    description: 'emit',
    parameters: { type: 'object', properties: {} },
    execute: async (_id: string, _input: unknown, ctx: ToolContext) => {
      captured.hadEmit = typeof ctx.emitProgress === 'function';
      ctx.emitProgress?.('step-1', 'child');
      ctx.emitProgress?.('step-2', 'child');
      return { type: 'text' as const, text: 'done' };
    },
  };
}

describe('LocalExecutionHarness emitProgress', () => {
  it('injects ctx.emitProgress and merges progress events into the output stream', async () => {
    const captured: { hadEmit?: boolean } = {};
    const tools = new CoreToolExecutor({ tools: [emittingTool(captured)], context: baseCtx });
    const harness = new LocalExecutionHarness({ architecture: archCallingTool(), llm: nullLLM, tools });

    const events: AgentEvent[] = [];
    for await (const ev of harness.execute({ prompt: 'go' })) events.push(ev);

    expect(captured.hadEmit).toBe(true);

    const progress = events.filter((e): e is Extract<AgentEvent, { type: 'progress' }> => e.type === 'progress');
    expect(progress.map((e) => e.message)).toEqual(['step-1', 'step-2']);
    expect(progress.every((e) => e.agent === 'child')).toBe(true);

    // The turn still completes normally — progress is interleaved, not terminal.
    expect(events.some((e) => e.type === 'done')).toBe(true);
    // Progress is surfaced before the turn ends.
    const doneIdx = events.findIndex((e) => e.type === 'done');
    const lastProgressIdx = events.map((e) => e.type).lastIndexOf('progress');
    expect(lastProgressIdx).toBeLessThan(doneIdx);
  });

  it('works when no tool emits progress (no regression to the normal path)', async () => {
    const tools = new CoreToolExecutor({
      tools: [{
        name: 'emit', description: 'noop', parameters: { type: 'object', properties: {} },
        execute: async () => ({ type: 'text' as const, text: 'x' }),
      }],
      context: baseCtx,
    });
    const harness = new LocalExecutionHarness({ architecture: archCallingTool(), llm: nullLLM, tools });

    const events: AgentEvent[] = [];
    for await (const ev of harness.execute({ prompt: 'go' })) events.push(ev);

    expect(events.some((e) => e.type === 'progress')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});
