import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PiAgentRunner } from '../pi-agent/runner.js';
import type { ToolExecutor } from '@nexora/contracts';

// Mock pi-agent-core's Agent — fake class that emits scripted events via subscribe.
type ScriptedEvent = { type: string; [k: string]: unknown };

vi.mock('@earendil-works/pi-agent-core', async () => {
  class FakeAgent {
    private listeners: Array<(ev: ScriptedEvent, signal: AbortSignal) => Promise<void> | void> = [];
    static scripted: ScriptedEvent[] = [];
    static abortSpy = vi.fn();
    state = { messages: [], systemPrompt: '', tools: [] };

    constructor(public options: any) {}

    subscribe(fn: (ev: ScriptedEvent, signal: AbortSignal) => Promise<void> | void) {
      this.listeners.push(fn);
      return () => { this.listeners = this.listeners.filter(l => l !== fn); };
    }

    async prompt(_input: any) {
      const ac = new AbortController();
      for (const ev of FakeAgent.scripted) {
        for (const l of this.listeners) await l(ev, ac.signal);
      }
    }

    abort() { FakeAgent.abortSpy(); }
    async waitForIdle() {}
  }
  return { Agent: FakeAgent };
});

import { Agent } from '@earendil-works/pi-agent-core';

const fakeExecutor: ToolExecutor = {
  execute: async () => 'unused — events are scripted',
  list: () => [],
};

const fakeModel = {
  id: 'mock', name: 'mock',
  api: 'openai-completions', provider: 'openai',
  reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000, maxTokens: 1000,
} as never;

describe('PiAgentRunner', () => {
  beforeEach(() => {
    (Agent as never as { scripted: ScriptedEvent[] }).scripted = [];
    (Agent as never as { abortSpy: ReturnType<typeof vi.fn> }).abortSpy.mockReset();
  });

  it('yields Nexora AgentEvents translated from pi events', async () => {
    (Agent as never as { scripted: ScriptedEvent[] }).scripted = [
      { type: 'agent_start' },
      {
        type: 'tool_execution_start',
        toolCallId: 't1', toolName: 'search', args: { q: 'x' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 't1', toolName: 'search',
        result: { content: [{ type: 'text', text: 'hits' }], details: undefined },
        isError: false,
      },
      {
        type: 'agent_end',
        messages: [
          { role: 'user', content: 'q', timestamp: 0 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'final answer' }],
            stopReason: 'stop',
            api: 'openai-completions', provider: 'openai', model: 'm',
            usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
            timestamp: 0,
          },
        ],
      },
    ];

    const runner = new PiAgentRunner({
      model: fakeModel,
      tools: [],
      toolExecutor: fakeExecutor,
      systemPrompt: 'sys',
    });
    const events = [];
    for await (const e of runner.execute({ prompt: 'q' })) events.push(e);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_call', id: 't1', name: 'search',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_result', id: 't1',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'done', content: 'final answer',
    }));
  });

  it('calls runBeforeExecution and runAfterExecution on middleware', async () => {
    (Agent as never as { scripted: ScriptedEvent[] }).scripted = [
      {
        type: 'agent_end',
        messages: [{ role: 'user', content: 'q', timestamp: 0 }],
      },
    ];

    const beforeExecution = vi.fn();
    const afterExecution = vi.fn();
    const runner = new PiAgentRunner({
      model: fakeModel,
      tools: [],
      toolExecutor: fakeExecutor,
      systemPrompt: 'sys',
      middlewares: [{ name: 'm', beforeExecution, afterExecution }],
    });

    for await (const _ of runner.execute({ prompt: 'q' })) { /* drain */ }

    expect(beforeExecution).toHaveBeenCalled();
    expect(afterExecution).toHaveBeenCalled();
  });

  it('abort() calls Agent.abort()', async () => {
    // Scripted but never reaches agent_end naturally — we'll abort before it ends.
    (Agent as never as { scripted: ScriptedEvent[] }).scripted = [
      {
        type: 'agent_end',
        messages: [{ role: 'user', content: 'q', timestamp: 0 }],
      },
    ];

    const runner = new PiAgentRunner({
      model: fakeModel, tools: [], toolExecutor: fakeExecutor, systemPrompt: 'sys',
    });
    const gen = runner.execute({ prompt: 'q' });
    // Start consuming so the Agent gets constructed and prompt() runs.
    const first = await gen.next();
    runner.abort();
    // Drain remaining.
    try { for await (const _ of gen) { /* */ } } catch { /* */ }

    expect((Agent as never as { abortSpy: ReturnType<typeof vi.fn> }).abortSpy).toHaveBeenCalled();
  });

  it('yields error event when Agent.prompt rejects', async () => {
    // Override prompt to throw.
    const originalPrompt = (Agent as never as { prototype: { prompt: unknown } }).prototype.prompt;
    (Agent as never as { prototype: { prompt: unknown } }).prototype.prompt = async () => {
      throw new Error('boom');
    };

    const runner = new PiAgentRunner({
      model: fakeModel, tools: [], toolExecutor: fakeExecutor, systemPrompt: 'sys',
    });
    const events = [];
    for await (const e of runner.execute({ prompt: 'q' })) events.push(e);
    expect(events).toContainEqual({ type: 'error', message: 'boom' });

    // Restore.
    (Agent as never as { prototype: { prompt: unknown } }).prototype.prompt = originalPrompt;
  });
});
