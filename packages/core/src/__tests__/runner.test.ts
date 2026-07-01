import { describe, it, expect, vi } from 'vitest';
import { LocalExecutionHarness } from '../execution-harness.js';
import { AgentRunner } from '../runner.js';
import { CoreToolExecutor } from '../tool-executor.js';
import { loggingMiddleware } from '../middleware.js';
import type {
  AgentArchitecture,
  RuntimeServices,
  AgentInput,
  AgentEvent,
  ExecutionHarness,
  ToolDefinition,
  ToolContext,
  ToolExecutor,
  ToolResult,
  WorkspaceProvider,
} from '@dongkseo/contracts';
import { suspendResult } from '@dongkseo/contracts';
import { MockLLMProvider } from './mock-llm.js';

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
      text: `echoed: ${(input as { msg: string }).msg}`,
    }),
  };
}

/** 단순 ReAct 스텁: LLM 한 번 호출 → 도구 호출 → 결과 받고 다시 호출 → done */
const simpleReact: AgentArchitecture = {
  name: 'simple-react',
  async *loop(services: RuntimeServices, input: AgentInput): AsyncGenerator<AgentEvent> {
    // 1차 호출: 도구 사용 결정 (signal 전달)
    const first = await services.llm.complete(
      [{ role: 'user', content: input.prompt }],
      { signal: services.signal },
    );

    if (first.toolCalls && first.toolCalls.length > 0) {
      for (const tc of first.toolCalls) {
        yield { type: 'tool_call', id: tc.id, name: tc.name, input: tc.arguments };
        const result = await services.tools.execute(tc.name, tc.id, tc.arguments, services.signal);
        yield {
          type: 'tool_result',
          id: tc.id,
          name: tc.name,
          result,
          isError: (result as { type: string }).type === 'error',
        };
      }

      // 2차 호출: 결과 보고 마무리
      const second = await services.llm.complete(
        [
          { role: 'user', content: input.prompt },
          { role: 'assistant', content: first.content },
          { role: 'user', content: 'tool ran' },
        ],
        { signal: services.signal },
      );
      if (second.content) yield { type: 'text', text: second.content };
      yield { type: 'done', content: second.content, toolCalls: first.toolCalls.map(t => ({ name: t.name, input: t.arguments })) };
    } else {
      if (first.content) yield { type: 'text', text: first.content };
      yield { type: 'done', content: first.content, toolCalls: [] };
    }
  },
};

describe('AgentRunner', () => {
  it('can execute through the isolated local harness contract', async () => {
    const llm = new MockLLMProvider([
      { text: 'local harness done' },
    ]);
    const tools = new CoreToolExecutor({ tools: [], context: mockContext });
    const harness: ExecutionHarness = new LocalExecutionHarness({
      architecture: simpleReact,
      llm,
      tools,
    });

    const events: AgentEvent[] = [];
    for await (const ev of harness.execute({ prompt: 'hi' })) {
      events.push(ev);
    }

    const done = events.find(e => e.type === 'done');
    expect(done).toBeDefined();
    if (done?.type === 'done') {
      expect(done.content).toBe('local harness done');
    }
  });

  it('injects acquired workspace sessions into tool context', async () => {
    let observedWorkdir: string | undefined;
    let observedWorkspaceRoot: string | undefined;
    const cleanup = vi.fn(async () => {});
    const provider: WorkspaceProvider = {
      acquire: vi.fn(async ({ baseWorkdir } = {}) => ({
        id: 'ws-1',
        root: '/isolated/workspace',
        mode: 'workspace-write',
        mounts: [],
        resolve: async (target: string) => ({
          path: `/isolated/workspace/${target}`,
          root: '/isolated/workspace',
          relativePath: target,
          access: 'ro',
        }),
        cleanup,
        snapshot: async () => ({ id: 'ws-1', root: '/isolated/workspace', metadata: { baseWorkdir } }),
      })),
    };
    const inspectTool: ToolDefinition = {
      name: 'inspect_workspace',
      description: 'Inspect workspace context',
      parameters: { type: 'object', properties: {} },
      execute: async (_id, _input, ctx) => {
        observedWorkdir = ctx.workdir;
        observedWorkspaceRoot = ctx.workspace?.root;
        return { type: 'text', text: 'ok' };
      },
    };
    const llm = new MockLLMProvider([
      { text: '', toolCalls: [{ id: 'tc-1', name: 'inspect_workspace', arguments: {} }] },
      { text: 'done' },
    ]);
    const tools = new CoreToolExecutor({ tools: [inspectTool], context: mockContext });
    const runner = new AgentRunner({
      architecture: simpleReact,
      llm,
      tools,
      workspaceProvider: provider,
    });

    for await (const _ of runner.execute({ prompt: 'inspect' })) {
      // consume stream
    }

    expect(provider.acquire).toHaveBeenCalledWith({
      baseWorkdir: mockContext.workdir,
      input: { prompt: 'inspect' },
    });
    expect(observedWorkdir).toBe('/isolated/workspace');
    expect(observedWorkspaceRoot).toBe('/isolated/workspace');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('forwards workspaceSeedDirs into workspaceProvider.acquire', async () => {
    const acquireCalls: unknown[] = [];
    const provider: WorkspaceProvider = {
      acquire: vi.fn(async (options) => {
        acquireCalls.push(options);
        return {
          id: 'ws-1',
          root: '/isolated/workspace',
          mode: 'workspace-write',
          mounts: [],
          resolve: async (target: string) => ({
            path: `/isolated/workspace/${target}`,
            root: '/isolated/workspace',
            relativePath: target,
            access: 'ro',
          }),
          cleanup: async () => {},
        };
      }),
    };
    const inspectTool: ToolDefinition = {
      name: 'inspect_workspace',
      description: 'Inspect workspace context',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ type: 'text', text: 'ok' }),
    };
    const llm = new MockLLMProvider([
      { text: '', toolCalls: [{ id: 'tc-1', name: 'inspect_workspace', arguments: {} }] },
      { text: 'done' },
    ]);
    const tools = new CoreToolExecutor({ tools: [inspectTool], context: mockContext });
    const runner = new AgentRunner({
      architecture: simpleReact,
      llm,
      tools,
      workspaceProvider: provider,
      workspaceSeedDirs: [{ source: '/tmp/skills', destSubpath: '.skill_refs' }],
    });

    for await (const _ of runner.execute({ prompt: 'inspect' })) {
      // drain
    }

    expect(acquireCalls[0]).toMatchObject({
      seedDirs: [{ source: '/tmp/skills', destSubpath: '.skill_refs' }],
    });
  });

  it('fails closed when workspaceProvider cannot inject tool context', async () => {
    const provider: WorkspaceProvider = {
      acquire: vi.fn(async () => {
        throw new Error('should not acquire');
      }),
    };
    const legacyTools: ToolExecutor = {
      list: () => [],
      execute: async () => ({ type: 'text', text: 'legacy' }),
    };
    const harness = new LocalExecutionHarness({
      architecture: simpleReact,
      llm: new MockLLMProvider([{ text: 'done' }]),
      tools: legacyTools,
      workspaceProvider: provider,
    });

    const events: AgentEvent[] = [];
    for await (const ev of harness.execute({ prompt: 'hi' })) {
      events.push(ev);
    }

    const err = events.find(e => e.type === 'error');
    expect(err).toBeDefined();
    if (err?.type === 'error') expect(err.message).toMatch(/getContext\(\).*withContext\(\)/);
    expect(provider.acquire).not.toHaveBeenCalled();
  });

  it('runs simple react loop with tool call', async () => {
    const llm = new MockLLMProvider([
      { text: '', toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { msg: 'hi' } }] },
      { text: 'I echoed your message: hi' },
    ]);

    const tools = new CoreToolExecutor({
      tools: [makeEcho()],
      context: mockContext,
    });

    const runner = new AgentRunner({
      architecture: simpleReact,
      llm,
      tools,
    });

    const events: AgentEvent[] = [];
    for await (const ev of runner.execute({ prompt: 'echo hi' })) {
      events.push(ev);
    }

    const types = events.map(e => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('done');

    const done = events.find(e => e.type === 'done');
    expect(done).toBeDefined();
    if (done?.type === 'done') {
      expect(done.content).toBe('I echoed your message: hi');
    }
  });

  it('runs without tools when LLM does not call any', async () => {
    const llm = new MockLLMProvider([
      { text: 'no tools needed' },
    ]);
    const tools = new CoreToolExecutor({ tools: [], context: mockContext });

    const runner = new AgentRunner({ architecture: simpleReact, llm, tools });

    const events: AgentEvent[] = [];
    for await (const ev of runner.execute({ prompt: 'hi' })) {
      events.push(ev);
    }

    expect(events.map(e => e.type)).not.toContain('tool_call');
    const done = events.find(e => e.type === 'done');
    if (done?.type === 'done') {
      expect(done.content).toBe('no tools needed');
    }
  });

  it('runs middleware hooks', async () => {
    const llm = new MockLLMProvider([{ text: 'done' }]);
    const tools = new CoreToolExecutor({ tools: [], context: mockContext });

    const infoSpy = vi.fn();
    const runner = new AgentRunner({
      architecture: simpleReact,
      llm,
      tools,
      middlewares: [loggingMiddleware({ info: infoSpy })],
    });

    for await (const _ of runner.execute({ prompt: 'hi' })) {
      // drain
    }

    const calls = infoSpy.mock.calls.map(c => c[0]);
    expect(calls).toContain('agent.start');
    expect(calls).toContain('agent.end');
  });

  it('runs beforeLLMCall and applies message/system prompt mutations', async () => {
    const llm = new MockLLMProvider([{ text: 'done' }]);
    const tools = new CoreToolExecutor({ tools: [], context: mockContext });
    const runner = new AgentRunner({
      architecture: simpleReact,
      llm,
      tools,
      middlewares: [
        {
          name: 'llm-guard',
          beforeLLMCall(ctx) {
            ctx.messages = [{ role: 'user', content: 'rewritten prompt' }];
            ctx.systemPrompt = 'guarded system';
          },
        },
      ],
    });

    for await (const _ of runner.execute({ prompt: 'original prompt' })) {
      // drain
    }

    expect(llm.callLog[0].messages).toEqual([{ role: 'user', content: 'rewritten prompt' }]);
    expect(llm.callLog[0].options?.systemPrompt).toBe('guarded system');
  });

  it('passes original tool input to afterToolCall middleware', async () => {
    const llm = new MockLLMProvider([
      { text: '', toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { msg: 'hi' } }] },
      { text: 'done' },
    ]);
    const tools = new CoreToolExecutor({ tools: [makeEcho()], context: mockContext });
    const afterInputs: unknown[] = [];
    const runner = new AgentRunner({
      architecture: simpleReact,
      llm,
      tools,
      middlewares: [
        {
          name: 'capture-after-tool',
          afterToolCall(ctx) {
            afterInputs.push(ctx.input);
          },
        },
      ],
    });

    for await (const _ of runner.execute({ prompt: 'echo hi' })) {
      // drain
    }

    expect(afterInputs).toEqual([{ msg: 'hi' }]);
  });

  it('preserves executeBatch on the signal-wrapped tool executor', async () => {
    let batchResult: ToolResult | undefined;
    const batchArch: AgentArchitecture = {
      name: 'batch-arch',
      async *loop(services: RuntimeServices, _input: AgentInput): AsyncGenerator<AgentEvent> {
        const results = await services.tools.executeBatch?.([
          { callId: 'tc-1', name: 'echo', input: { msg: 'hi' } },
        ], services.signal);
        batchResult = results?.[0]?.result;
        yield { type: 'done', content: 'ok', toolCalls: [] };
      },
    };
    const runner = new AgentRunner({
      architecture: batchArch,
      llm: new MockLLMProvider([]),
      tools: new CoreToolExecutor({ tools: [makeEcho()], context: mockContext }),
    });

    for await (const _ of runner.execute({ prompt: 'echo hi' })) {
      // drain
    }

    expect(batchResult).toEqual({ type: 'text', text: 'echoed: hi' });
  });

  it('applies beforeExecution tool mutations to the executor used by the architecture', async () => {
    const llm = new MockLLMProvider([
      { text: '', toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { msg: 'hi' } }] },
      { text: 'done' },
    ]);
    const tools = new CoreToolExecutor({ tools: [makeEcho()], context: mockContext });
    const runner = new AgentRunner({
      architecture: simpleReact,
      llm,
      tools,
      middlewares: [
        {
          name: 'wrap-echo',
          beforeExecution(ctx) {
            ctx.tools = ctx.tools.map((tool) =>
              tool.name === 'echo'
                ? {
                    ...tool,
                    execute: async () => ({ type: 'text', text: 'wrapped' }),
                  }
                : tool,
            );
          },
        },
      ],
    });

    const events: AgentEvent[] = [];
    for await (const ev of runner.execute({ prompt: 'echo hi' })) {
      events.push(ev);
    }

    const result = events.find(e => e.type === 'tool_result');
    expect(result).toBeDefined();
    if (result?.type === 'tool_result') {
      expect(result.result).toEqual({ type: 'text', text: 'wrapped' });
    }
  });

  it('emits error event on architecture throw', async () => {
    const llm = new MockLLMProvider([{ text: '', throwError: 'llm exploded' }]);
    const tools = new CoreToolExecutor({ tools: [], context: mockContext });
    const runner = new AgentRunner({ architecture: simpleReact, llm, tools });

    const events: AgentEvent[] = [];
    for await (const ev of runner.execute({ prompt: 'hi' })) {
      events.push(ev);
    }

    const errorEvent = events.find(e => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      expect(errorEvent.message).toContain('llm exploded');
    }
  });

  // Cancellation: idle timeout aborts in-flight LLM call AND closes the generator
  // so the architecture cannot keep running after the user gave up.
  it('idle timeout aborts ongoing LLM call', async () => {
    let llmAborted = false;
    const slowLlm = {
      stream: async function* () { /* not used */ },
      complete: async (_msgs: unknown, opts?: { signal?: AbortSignal }) => {
        return new Promise<never>((_, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            llmAborted = true;
            reject(new Error('aborted by signal'));
          });
        });
      },
    } as unknown as ConstructorParameters<typeof AgentRunner>[0]['llm'];

    const tools = new CoreToolExecutor({ tools: [], context: mockContext });
    const runner = new AgentRunner({
      architecture: simpleReact,
      llm: slowLlm,
      tools,
      idleTimeoutMs: 50,
    });

    const events: AgentEvent[] = [];
    for await (const ev of runner.execute({ prompt: 'hi' })) {
      events.push(ev);
    }

    expect(llmAborted).toBe(true);
    const err = events.find(e => e.type === 'error');
    expect(err).toBeDefined();
    if (err?.type === 'error') expect(err.message).toMatch(/idle timeout/);
  });

  // Regression for the listener-leak in raceAgainstAbort: each yield registered
  // an abort listener but never removed it on the success path. A long-running
  // generator would accumulate one listener per iteration.
  it('raceAgainstAbort does not leak abort listeners across iterations', async () => {
    let peak = 0;

    const observingArch: AgentArchitecture = {
      name: 'observing',
      async *loop(services: RuntimeServices, _input: AgentInput): AsyncGenerator<AgentEvent> {
        // Instrument the signal BEFORE the runner's race cycle runs for the
        // next yield. We count every `addEventListener('abort')` vs every
        // `removeEventListener('abort')` to track the current live count.
        let current = 0;
        const sig = services.signal as AbortSignal & {
          addEventListener: (t: string, l: unknown, o?: unknown) => unknown;
          removeEventListener: (t: string, l: unknown, o?: unknown) => unknown;
        };
        const origAdd = sig.addEventListener.bind(sig);
        const origRemove = sig.removeEventListener.bind(sig);
        sig.addEventListener = (type, listener, opts) => {
          if (type === 'abort') {
            current++;
            if (current > peak) peak = current;
          }
          return origAdd(type, listener, opts);
        };
        sig.removeEventListener = (type, listener, opts) => {
          if (type === 'abort') current--;
          return origRemove(type, listener, opts);
        };

        for (let i = 0; i < 50; i++) {
          yield { type: 'text', text: `chunk ${i}` };
        }
        yield { type: 'done', content: 'ok', toolCalls: [] };
      },
    };

    const runner = new AgentRunner({
      architecture: observingArch,
      llm: new MockLLMProvider([]),
      tools: new CoreToolExecutor({ tools: [], context: mockContext }),
    });

    for await (const _ of runner.execute({ prompt: 'x' })) {
      // drain
    }

    // Without the fix this would grow to ~50. With the fix peak stays tiny
    // (at most 1 concurrent listener from raceAgainstAbort's Promise.race).
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('explicit abort() stops execution and closes generator', async () => {
    let started = false;
    const blockingArch: AgentArchitecture = {
      name: 'blocking',
      async *loop(services: RuntimeServices, _input: AgentInput): AsyncGenerator<AgentEvent> {
        started = true;
        // Real architectures honor services.signal — wait until aborted.
        await new Promise<void>((_, reject) => {
          services.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        yield { type: 'text', text: 'should never reach' };
        yield { type: 'done', content: 'never', toolCalls: [] };
      },
    };

    const runner = new AgentRunner({
      architecture: blockingArch,
      llm: new MockLLMProvider([]),
      tools: new CoreToolExecutor({ tools: [], context: mockContext }),
      idleTimeoutMs: 60_000,
    });

    const collected: AgentEvent[] = [];
    const consumer = (async () => {
      for await (const ev of runner.execute({ prompt: 'hi' })) {
        collected.push(ev);
      }
    })();

    await new Promise(r => setTimeout(r, 30));
    expect(started).toBe(true);
    runner.abort();
    await consumer;

    const err = collected.find(e => e.type === 'error');
    expect(err).toBeDefined();
    if (err?.type === 'error') expect(err.message).toBe('aborted');
  });

  it('AgentRunner forwards onSuspend to RuntimeServices', async () => {
    const calls: { pendingId: string }[] = [];

    // Minimal architecture: calls a tool that returns suspend, then invokes
    // services.onSuspend and emits the suspended event — mirroring what the
    // real ReAct architecture does (A3).
    const suspendArch: AgentArchitecture = {
      name: 'suspend-arch',
      async *loop(services: RuntimeServices, input: AgentInput): AsyncGenerator<AgentEvent> {
        const callId = 'c1';
        yield { type: 'tool_call', id: callId, name: 'ask', input: {} };
        const result = await services.tools.execute('ask', callId, {}, services.signal);
        yield { type: 'tool_result', id: callId, name: 'ask', result, isError: false };

        if ((result as { type: string }).type === 'suspend') {
          const { pendingId } = result as { type: 'suspend'; pendingId: string };
          await services.onSuspend?.({
            pendingId,
            toolCallId: callId,
            architectureHistory: [{ role: 'user', content: input.prompt }],
          });
          yield { type: 'suspended', pendingId, toolCallId: callId };
        } else {
          yield { type: 'done', content: '', toolCalls: [] };
        }
      },
    };

    const askTool: ToolDefinition = {
      name: 'ask',
      description: 'Ask a human',
      parameters: { type: 'object', properties: {} },
      execute: async () => suspendResult('pid-1'),
    };

    const runner = new AgentRunner({
      architecture: suspendArch,
      llm: new MockLLMProvider([]),
      tools: new CoreToolExecutor({ tools: [askTool], context: mockContext }),
      onSuspend: async ({ pendingId }) => { calls.push({ pendingId }); },
    });

    const events: AgentEvent[] = [];
    for await (const ev of runner.execute({ prompt: 'go' })) events.push(ev);

    expect(calls).toEqual([{ pendingId: 'pid-1' }]);
    expect(events.some(e => e.type === 'suspended')).toBe(true);
  });
});
