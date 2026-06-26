/**
 * Integration: the execution harness drives the *real* monitoring/self-wake and
 * budget wiring end-to-end.
 *
 * These cover the "wiring gaps" where the harness already injected the plumbing
 * (ctx.triggers, the middleware pipeline) but nothing consumed it:
 *   - schedule_monitor arms a monitor on the harness-injected TriggerHost and
 *     its wake reaches the harness wake channels (steerSelf / deliverResult).
 *   - createBudgetMiddleware records cost through the pipeline after a turn.
 *   - the knowledge tool, backed by a real KnowledgeStoreJson, persists to disk
 *     (vs. the no-op stub it used to be wired with).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalExecutionHarness } from '../execution-harness.js';
import { CoreToolExecutor } from '../tool-executor.js';
import { createBudgetMiddleware } from '../budget-middleware.js';
import { createScheduleMonitorTool, createKnowledgeTool } from '@dongkseo/tools';
import { KnowledgeStoreJson } from '@dongkseo/store-json';
import type {
  AgentArchitecture, AgentEvent, AgentInput, RuntimeServices, ToolContext,
  LLMProvider, BudgetTracker, CostEvent, TriggerHost, TriggerSpec,
} from '@dongkseo/contracts';

const baseCtx: ToolContext = {
  tenantId: 'default', workdir: '/tmp',
  secrets: { get: async () => undefined },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

const nullLLM = { complete: async () => ({ content: '', toolCalls: [] }) } as unknown as LLMProvider;

/** Controllable TriggerHost: captures armed specs; optionally fires on arm. */
class FakeTriggerHost implements TriggerHost {
  readonly armed: TriggerSpec[] = [];
  constructor(private readonly fireOnArm = false) {}
  arm(spec: TriggerSpec): string {
    this.armed.push(spec);
    if (this.fireOnArm) spec.onFire();
    return `trig-${this.armed.length}`;
  }
  cancel(): boolean { return true; }
  list() { return this.armed.map((s, i) => ({ id: `trig-${i + 1}`, label: s.label ?? '', fires: 0 })); }
}

/** Architecture that calls schedule_monitor once, then optionally surfaces any
 *  steers it received as the done content. */
function monitorArchitecture(
  toolInput: Record<string, unknown>,
  opts: { drainAfter?: boolean } = {},
): AgentArchitecture {
  return {
    name: 'monitor-probe',
    async *loop(services: RuntimeServices, _input: AgentInput): AsyncGenerator<AgentEvent> {
      await services.tools.execute('schedule_monitor', 'c1', toolInput, services.signal);
      const steers = opts.drainAfter ? services.drainSteers() : [];
      yield { type: 'done', content: JSON.stringify(steers), toolCalls: [] };
    },
  } as unknown as AgentArchitecture;
}

function doneArchitecture(content: string): AgentArchitecture {
  return {
    name: 'done',
    async *loop(_services: RuntimeServices, _input: AgentInput): AsyncGenerator<AgentEvent> {
      yield { type: 'done', content, toolCalls: [] };
    },
  } as unknown as AgentArchitecture;
}

describe('harness ↔ schedule_monitor (trigger spine)', () => {
  it('arms a monitor on the injected TriggerHost and delivers the wake post-turn via deliverResult', async () => {
    const fakeHost = new FakeTriggerHost(/* fireOnArm */ false);
    const delivered: Array<{ content: string }> = [];
    const tools = new CoreToolExecutor({ tools: [createScheduleMonitorTool()], context: baseCtx });

    const harness = new LocalExecutionHarness({
      architecture: monitorArchitecture({ prompt: 'check build', every_ms: 1000, max_fires: 3 }),
      llm: nullLLM,
      tools,
      triggers: fakeHost,
      deliverResult: (r) => { delivered.push(r as { content: string }); },
    });

    for await (const _ev of harness.execute({ prompt: 'go' })) { /* drain */ }

    // The tool consumed the harness-injected ctx.triggers and armed a bounded,
    // recurring monitor — if triggers weren't wired it would have errored and
    // never called arm().
    expect(fakeHost.armed).toHaveLength(1);
    expect(fakeHost.armed[0].recurring).toBe(true);
    expect(fakeHost.armed[0].maxFires).toBe(3);

    // Turn has ended → steerSelf returns false → the wake falls through to the
    // harness deliverResult sink.
    fakeHost.armed[0].onFire();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].content).toContain('check build');
  });

  it('folds the wake into the live turn via steerSelf when it fires mid-turn', async () => {
    const fakeHost = new FakeTriggerHost(/* fireOnArm */ true); // fires while the loop is active
    const tools = new CoreToolExecutor({ tools: [createScheduleMonitorTool()], context: baseCtx });

    const harness = new LocalExecutionHarness({
      architecture: monitorArchitecture(
        { prompt: 'check build', every_ms: 1000, max_fires: 3 },
        { drainAfter: true },
      ),
      llm: nullLLM,
      tools,
      triggers: fakeHost,
    });

    const events: AgentEvent[] = [];
    for await (const ev of harness.execute({ prompt: 'go' })) events.push(ev);

    const done = events.find(e => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
    expect(done.content).toContain('tick #1');
    expect(done.content).toContain('check build');
  });
});

describe('harness ↔ budget middleware (pipeline)', () => {
  it('records a cost event through the middleware pipeline after a turn', async () => {
    const recorded: CostEvent[] = [];
    const fakeTracker = {
      record: async (e: CostEvent) => { recorded.push(e); return []; },
      check: async () => [],
      listPolicies: async () => [],
      addPolicy: async () => {},
      getSpend: async () => 0,
    } as unknown as BudgetTracker;

    const tools = new CoreToolExecutor({ tools: [], context: baseCtx });
    const harness = new LocalExecutionHarness({
      architecture: doneArchitecture('hello world'),
      llm: nullLLM,
      tools,
      middlewares: [createBudgetMiddleware({
        tracker: fakeTracker,
        agentName: 'budget-agent',
        tenantId: 'default',
        model: 'claude-haiku-4-5',
      })],
    });

    for await (const _ev of harness.execute({ prompt: 'go' })) { /* drain */ }

    expect(recorded).toHaveLength(1);
    expect(recorded[0].agentName).toBe('budget-agent');
    expect(recorded[0].outputTokens).toBeGreaterThan(0);
    expect(recorded[0].costUsd).toBeGreaterThan(0);
  });
});

describe('knowledge tool ↔ KnowledgeStoreJson (real backend)', () => {
  it('persists a write to disk and reads it back through the tool', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-knowledge-'));
    try {
      const store = new KnowledgeStoreJson(dir);
      const tool = createKnowledgeTool(store);
      const ctx: ToolContext = { ...baseCtx, workdir: dir };

      const w = await tool.execute('w1', { action: 'write', topic: 'rules', content: '# Rules\nbe nice' }, ctx);
      expect(w.type).toBe('text');

      // Persisted to disk under the tenant namespace (no more no-op stub).
      const onDisk = path.join(dir, 'knowledge', 'default', 'rules.md');
      expect(fs.existsSync(onDisk)).toBe(true);

      const r = await tool.execute('r1', { action: 'read', topic: 'rules' }, ctx);
      expect(r.type).toBe('text');
      if (r.type === 'text') expect(r.text).toContain('be nice');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
