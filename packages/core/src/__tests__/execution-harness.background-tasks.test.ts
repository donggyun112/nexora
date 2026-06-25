import { describe, it, expect } from 'vitest';
import { LocalExecutionHarness } from '../execution-harness.js';
import { CoreToolExecutor } from '../tool-executor.js';
import { InMemoryBackgroundTaskRegistry } from '@dongkseo/contracts';
import type {
  AgentArchitecture, AgentEvent, AgentInput, RuntimeServices, ToolContext, LLMProvider,
} from '@dongkseo/contracts';

const baseCtx: ToolContext = {
  tenantId: 'default', workdir: '/tmp',
  secrets: { get: async () => undefined },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

// Architecture that calls one tool then finishes, so we can inspect the ctx the tool saw.
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

describe('LocalExecutionHarness background-task wiring', () => {
  it('injects backgroundTasks and deliverResult into the tool ToolContext', async () => {
    const captured: { ctx?: ToolContext } = {};
    const registry = new InMemoryBackgroundTaskRegistry();
    const delivered: unknown[] = [];

    const tools = new CoreToolExecutor({ tools: [probeTool(captured)], context: baseCtx });

    const harness = new LocalExecutionHarness({
      architecture: probeArchitecture(),
      llm: nullLLM,
      tools,
      backgroundTasks: registry,
      deliverResult: (r) => { delivered.push(r); },
    });

    for await (const _ev of harness.execute({ prompt: 'go' })) { /* drain */ }

    expect(captured.ctx?.backgroundTasks).toBe(registry);
    expect(typeof captured.ctx?.deliverResult).toBe('function');
  });

  it('provides a default registry when none is supplied', async () => {
    const captured: { ctx?: ToolContext } = {};
    const tools = new CoreToolExecutor({ tools: [probeTool(captured)], context: baseCtx });
    const harness = new LocalExecutionHarness({ architecture: probeArchitecture(), llm: nullLLM, tools });
    for await (const _ev of harness.execute({ prompt: 'go' })) { /* drain */ }
    expect(captured.ctx?.backgroundTasks).toBeDefined();
  });
});
