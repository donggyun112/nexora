import { describe, expect, it } from 'vitest';
import type {
  AgentArchitecture,
  AgentEvent,
  LLMProvider,
  RuntimeOrchestrator,
  RuntimeServices,
  ToolExecutor,
} from '@dongkseo/contracts';
import { OrchestrationControlError } from '@dongkseo/contracts';
import { LocalExecutionHarness } from '../execution-harness.js';

function model(onComplete: () => void): LLMProvider {
  return {
    async *stream() {
      yield { type: 'done', content: '', stopReason: 'end' } as const;
    },
    async complete() {
      onComplete();
      return { content: 'model', model: 'test', stopReason: 'end' };
    },
  };
}

function tools(onExecute: () => void): ToolExecutor {
  return {
    async execute() {
      onExecute();
      return { type: 'text', text: 'tool' };
    },
    list: () => [],
  };
}

const probeArchitecture: AgentArchitecture = {
  name: 'orchestration-probe',
  async *loop(services: RuntimeServices): AsyncGenerator<AgentEvent> {
    const response = await services.llm.complete([{ role: 'user', content: 'go' }]);
    await services.tools.execute('probe', 'call-1', {});
    yield { type: 'done', content: response.content, toolCalls: [] };
  },
};

async function drain(harness: LocalExecutionHarness): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of harness.execute({ prompt: 'go' })) events.push(event);
  return events;
}

describe('LocalExecutionHarness orchestration port', () => {
  it('uses direct model and tool execution when no orchestrator is attached', async () => {
    let modelCalls = 0;
    let toolCalls = 0;
    const harness = new LocalExecutionHarness({
      architecture: probeArchitecture,
      llm: model(() => modelCalls++),
      tools: tools(() => toolCalls++),
    });

    const events = await drain(harness);

    expect(events.at(-1)).toMatchObject({ type: 'done', content: 'model' });
    expect(modelCalls).toBe(1);
    expect(toolCalls).toBe(1);
  });

  it('attaches an arbitrary execution-scoped orchestrator and always closes it', async () => {
    const calls: string[] = [];
    const orchestrator: RuntimeOrchestrator = {
      async open(context) {
        calls.push(`open:${context.input.prompt}`);
        return {
          wrapLLM(inner) {
            calls.push('wrap:llm');
            return {
              stream: inner.stream.bind(inner),
              async complete(messages, options) {
                calls.push('call:llm');
                return inner.complete(messages, options);
              },
            };
          },
          wrapTools(inner) {
            calls.push('wrap:tools');
            return {
              list: () => inner.list(),
              async execute(name, callId, input, signal) {
                calls.push('call:tool');
                return inner.execute(name, callId, input, signal);
              },
            };
          },
          async close() {
            calls.push('close');
          },
        };
      },
    };
    const harness = new LocalExecutionHarness({
      architecture: probeArchitecture,
      llm: model(() => calls.push('inner:llm')),
      tools: tools(() => calls.push('inner:tool')),
      orchestrator,
    });

    await drain(harness);

    expect(calls).toEqual([
      'open:go',
      'wrap:tools',
      'wrap:llm',
      'call:llm',
      'inner:llm',
      'call:tool',
      'inner:tool',
      'close',
    ]);
  });

  it('lets generic orchestration control failures escape the agent event stream', async () => {
    const orchestrator: RuntimeOrchestrator = {
      async open() {
        throw new OrchestrationControlError('ownership moved');
      },
    };
    const harness = new LocalExecutionHarness({
      architecture: probeArchitecture,
      llm: model(() => {}),
      tools: tools(() => {}),
      orchestrator,
    });

    await expect(drain(harness)).rejects.toThrow('ownership moved');
  });

  it('rejects the legacy durability adapter when an orchestrator is also supplied', () => {
    const orchestrator: RuntimeOrchestrator = {
      async open() {
        throw new Error('unused');
      },
    };
    expect(() => new LocalExecutionHarness({
      architecture: probeArchitecture,
      llm: model(() => {}),
      tools: tools(() => {}),
      orchestrator,
      durability: {
        ledger: {} as never,
        runId: 'run-1',
      },
    })).toThrow('Set either orchestrator or durability, not both');
  });
});
