import { describe, it, expect } from 'vitest';

import { LocalExecutionHarness } from '../execution-harness.js';
import { KeyedSerializer } from '../keyed-serializer.js';
import { CoreToolExecutor } from '../tool-executor.js';
import type {
  AgentArchitecture, AgentEvent, AgentInput, RuntimeServices, ToolContext, LLMProvider,
} from '@dongkseo/contracts';

const baseCtx: ToolContext = {
  tenantId: 'default', workdir: '/tmp',
  secrets: { get: async () => undefined },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

function probeArchitecture(): AgentArchitecture {
  return {
    name: 'probe',
    async *loop(services: RuntimeServices, _input: AgentInput): AsyncGenerator<AgentEvent> {
      await services.tools.execute('probe', 'c1', {}, services.signal);
      yield { type: 'done', content: 'ok', toolCalls: [] };
    },
  } as unknown as AgentArchitecture;
}

const nullLLM = { complete: async () => ({ content: '', toolCalls: [] }) } as unknown as LLMProvider;

function probeTool(captured: { ctx?: ToolContext }) {
  return {
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object', properties: {} },
    execute: async (_id: string, _input: unknown, ctx: ToolContext) => {
      captured.ctx = ctx;
      return { type: 'text' as const, text: 'x' };
    },
  };
}

describe('LocalExecutionHarness resourceLock wiring', () => {
  it('injects the resourceLock into the tool ToolContext', async () => {
    const captured: { ctx?: ToolContext } = {};
    const lock = new KeyedSerializer();
    const tools = new CoreToolExecutor({ tools: [probeTool(captured)], context: baseCtx });

    const harness = new LocalExecutionHarness({
      architecture: probeArchitecture(),
      llm: nullLLM,
      tools,
      resourceLock: lock,
    });

    for await (const _ev of harness.execute({ prompt: 'go' })) { /* drain */ }

    expect(captured.ctx?.resourceLock).toBe(lock);
  });

  it('omits resourceLock when none is provided (single agent → zero overhead)', async () => {
    const captured: { ctx?: ToolContext } = {};
    const tools = new CoreToolExecutor({ tools: [probeTool(captured)], context: baseCtx });

    const harness = new LocalExecutionHarness({
      architecture: probeArchitecture(),
      llm: nullLLM,
      tools,
    });

    for await (const _ev of harness.execute({ prompt: 'go' })) { /* drain */ }

    expect(captured.ctx?.resourceLock).toBeUndefined();
  });

  it('shares one lock instance across sibling harnesses (parallel fan-out coordination)', async () => {
    const a: { ctx?: ToolContext } = {};
    const b: { ctx?: ToolContext } = {};
    const lock = new KeyedSerializer();

    const harnessA = new LocalExecutionHarness({
      architecture: probeArchitecture(), llm: nullLLM,
      tools: new CoreToolExecutor({ tools: [probeTool(a)], context: baseCtx }),
      resourceLock: lock,
    });
    const harnessB = new LocalExecutionHarness({
      architecture: probeArchitecture(), llm: nullLLM,
      tools: new CoreToolExecutor({ tools: [probeTool(b)], context: baseCtx }),
      resourceLock: lock,
    });

    for await (const _ev of harnessA.execute({ prompt: 'go' })) { /* drain */ }
    for await (const _ev of harnessB.execute({ prompt: 'go' })) { /* drain */ }

    // Both siblings see the SAME lock → same-key writes across them serialize.
    expect(a.ctx?.resourceLock).toBe(lock);
    expect(b.ctx?.resourceLock).toBe(lock);
    expect(a.ctx?.resourceLock).toBe(b.ctx?.resourceLock);
  });
});
