import { describe, expect, it } from 'vitest';
import type {
  AgentArchitecture,
  AgentEvent,
  AgentInput,
  LLMProvider,
  RuntimeOrchestrator,
  RuntimeServices,
  RuntimeInputQueue,
  ToolExecutor,
} from '@dongkseo/contracts';
import { OrchestrationControlError } from '@dongkseo/contracts';
import { DurableRuntimeOrchestrator } from '../durable-runtime-orchestrator.js';
import { LocalExecutionHarness } from '../execution-harness.js';
import { MemoryEffectLedger } from '../memory-effect-ledger.js';

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

async function drain(
  harness: LocalExecutionHarness,
  input: AgentInput = { prompt: 'go' },
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of harness.execute(input)) events.push(event);
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

  it('routes the initial prompt through durable claim and admission when an input queue is attached', async () => {
    const ledger = new MemoryEffectLedger();
    const admittedPrompts: string[] = [];
    const architecture: AgentArchitecture = {
      name: 'input-probe',
      async *loop(services): AsyncGenerator<AgentEvent> {
        const pending = await services.inputs?.claim() ?? [];
        for (const item of pending) {
          if ('input' in item) admittedPrompts.push(item.input.prompt);
        }
        await services.inputs?.admit(pending);
        yield { type: 'done', content: 'done', toolCalls: [] };
      },
    };
    const orchestrator = new DurableRuntimeOrchestrator({
      ledger,
      inputQueue: ledger,
      runId: 'run-inputs',
    });
    const harness = new LocalExecutionHarness({
      architecture,
      llm: model(() => {}),
      tools: tools(() => {}),
      orchestrator,
    });

    await drain(harness, { inputId: 'input-1', prompt: 'queued once' });
    await drain(harness, { inputId: 'input-1', prompt: 'queued once' });

    expect(admittedPrompts).toEqual(['queued once', 'queued once']);
    expect(await ledger.listInputs('run-inputs')).toMatchObject([{
      inputId: 'input-1',
      status: 'admitted',
      sequence: 0,
    }]);
  });

  it('routes an in-flight steer through the attached durable input queue', async () => {
    const ledger = new MemoryEffectLedger();
    let releaseTurn!: () => void;
    const turnReleased = new Promise<void>(resolve => { releaseTurn = resolve; });
    let initialAdmitted!: () => void;
    const initialWasAdmitted = new Promise<void>(resolve => { initialAdmitted = resolve; });
    const kinds: string[] = [];
    const architecture: AgentArchitecture = {
      name: 'steer-input-probe',
      async *loop(services): AsyncGenerator<AgentEvent> {
        const initial = await services.inputs!.claim();
        kinds.push(...initial.map(item => item.kind));
        await services.inputs!.admit(initial);
        initialAdmitted();
        await turnReleased;
        const late = await services.inputs!.claim();
        kinds.push(...late.map(item => item.kind));
        await services.inputs!.admit(late);
        yield { type: 'done', content: 'done', toolCalls: [] };
      },
    };
    const harness = new LocalExecutionHarness({
      architecture,
      llm: model(() => {}),
      tools: tools(() => {}),
      orchestrator: new DurableRuntimeOrchestrator({
        ledger,
        inputQueue: ledger,
        runId: 'run-steer',
      }),
    });

    const running = drain(harness, { inputId: 'prompt-1', prompt: 'start' });
    await initialWasAdmitted;
    expect(harness.steer('change direction')).toBe(true);
    releaseTurn();
    await running;

    expect(kinds).toEqual(['user_prompt', 'user_steer']);
    expect(await ledger.listInputs('run-steer')).toHaveLength(2);
    expect((await ledger.listInputs('run-steer')).every(record => record.status === 'admitted')).toBe(true);
  });

  it('releases the run lease when initial durable input submission fails', async () => {
    const ledger = new MemoryEffectLedger();
    const failingQueue: RuntimeInputQueue = {
      enqueueInput: async () => { throw new Error('queue unavailable'); },
      listInputs: async () => [],
      claimInput: async () => {},
      admitInputs: async () => {},
      discardInputs: async () => {},
    };
    const harness = new LocalExecutionHarness({
      architecture: probeArchitecture,
      llm: model(() => {}),
      tools: tools(() => {}),
      orchestrator: new DurableRuntimeOrchestrator({
        ledger,
        inputQueue: failingQueue,
        runId: 'run-open-failure',
      }),
    });

    expect(await drain(harness)).toContainEqual({ type: 'error', message: 'queue unavailable' });
    expect(await ledger.acquire('run-open-failure', 'next-worker', 60_000)).toBeGreaterThan(0);
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
