# Monitoring Triggers — Phase 1 (Timer Source + schedule_monitor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a clock (timer) trigger source and an agent-facing `schedule_monitor` tool so an agent can arm a recurring self-wake ("every N, wake me to check X"), with `cancel_monitor` / `list_monitors` and `max_fires`/`ttl` guardrails — all on the Phase 0 `armTrigger` spine.

**Architecture:** A generic `EventSource` (`subscribe → unsubscribe`); `createIntervalSource(ms)` is the clock source. An `InMemoryTriggerHost` (injected on `ToolContext.triggers`, owned by the harness so it survives across turns) arms triggers via `armTrigger`, tracks them for `list`/`cancel`, and tears down the source on cancel. `schedule_monitor` arms a timer-sourced trigger whose fire delivers a wake message through the existing `ctx.steerSelf`/`ctx.deliverResult` channels.

**Tech Stack:** TypeScript (ESM `.js` specifiers), Vitest (fake timers), pnpm + turbo.

## Global Constraints

- ESM `.js` specifiers; no new deps.
- Per-package: `cd packages/<pkg> && pnpm vitest run <path>`. Root: `pnpm build`, `pnpm test`.
- Timers MUST be `unref`'d so a monitor never keeps the process alive.
- Guardrails mandatory: a monitor MUST be bounded — `max_fires` (default 10) and/or `ttl_ms`; interval floored at 1000ms. No unbounded self-wake.
- Wake delivery rides existing channels: `ctx.steerSelf` (live/buffered) → `ctx.deliverResult` (post-turn sink) → log+drop. Waking a fully-idle process into a new turn is the app/adapter's `deliverResult` responsibility (out of scope — same boundary as background subagents).
- `armTrigger` (Phase 0) is reused unchanged. `TriggerHost` is generic over `EventSource` so task/stream/topic sources plug in later.
- Build green at every commit: contracts (Task 1) → core (Task 2) → tools (Task 3).
- `Date.now()` allowed (production code).

---

## File Structure

- `packages/contracts/src/trigger.ts` — **modify**. Add `EventSource`, `createIntervalSource`, `TriggerHost` interface, `InMemoryTriggerHost`.
- `packages/contracts/src/tool.ts` — **modify**. Add `ToolContext.triggers?: TriggerHost`.
- `packages/contracts/src/index.ts` — **modify**. Export the new symbols.
- `packages/contracts/src/__tests__/trigger.test.ts` — **modify**. Add interval-source + host tests.
- `packages/core/src/execution-harness.ts` — **modify**. Own + inject a `TriggerHost`.
- `packages/core/src/__tests__/execution-harness.background-tasks.test.ts` — **modify**. Assert `ctx.triggers` injected.
- `packages/tools/src/builtin/schedule-monitor.ts` — **new**. `schedule_monitor`/`cancel_monitor`/`list_monitors`.
- `packages/tools/src/builtin/index.ts` — **modify**. Export them.
- `packages/tools/src/__tests__/schedule-monitor.test.ts` — **new**.

---

### Task 1: contracts — EventSource, interval source, TriggerHost

**Files:**
- Modify: `packages/contracts/src/trigger.ts`, `packages/contracts/src/tool.ts`, `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/__tests__/trigger.test.ts`

**Interfaces:**
- Produces: `interface EventSource { subscribe(onEvent: () => void): () => void; stop?(): void }`
- Produces: `function createIntervalSource(intervalMs: number): EventSource` (internally `setInterval`, unref'd; `stop()` clears it)
- Produces: `interface MonitorSnapshot { id: string; label: string; createdAt: number; fires: number }`
- Produces: `interface TriggerHost { arm(spec: { label: string; source: EventSource; isSatisfied?: () => boolean; onFire: () => void; recurring?: boolean; maxFires?: number; ttlMs?: number; now: number }): string; cancel(id: string): boolean; list(): MonitorSnapshot[] }`
- Produces: `class InMemoryTriggerHost implements TriggerHost`
- Produces: `ToolContext.triggers?: TriggerHost`
- Consumes: `armTrigger` (Phase 0).

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/__tests__/trigger.test.ts`:

```ts
import { createIntervalSource, InMemoryTriggerHost } from '../trigger.js';
import { vi } from 'vitest';

describe('createIntervalSource', () => {
  it('emits to subscribers on each interval and stops on unsubscribe/stop', () => {
    vi.useFakeTimers();
    try {
      const src = createIntervalSource(1000);
      let ticks = 0;
      const off = src.subscribe(() => { ticks++; });
      vi.advanceTimersByTime(3000);
      expect(ticks).toBe(3);
      off();
      vi.advanceTimersByTime(2000);
      expect(ticks).toBe(3); // unsubscribed
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('InMemoryTriggerHost', () => {
  it('arms a recurring timer monitor, fires up to maxFires, then auto-drops from list', () => {
    vi.useFakeTimers();
    try {
      const host = new InMemoryTriggerHost();
      let fires = 0;
      const id = host.arm({
        label: 'check-x', source: createIntervalSource(1000),
        onFire: () => { fires++; }, recurring: true, maxFires: 2, now: 0,
      });
      expect(host.list().map((m) => m.id)).toEqual([id]);
      vi.advanceTimersByTime(5000);
      expect(fires).toBe(2);            // capped
      expect(host.list()).toEqual([]);  // auto-removed after maxFires
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel stops the timer and removes the monitor', () => {
    vi.useFakeTimers();
    try {
      const host = new InMemoryTriggerHost();
      let fires = 0;
      const id = host.arm({ label: 'm', source: createIntervalSource(1000), onFire: () => { fires++; }, recurring: true, maxFires: 100, now: 0 });
      vi.advanceTimersByTime(1000);
      expect(fires).toBe(1);
      expect(host.cancel(id)).toBe(true);
      vi.advanceTimersByTime(5000);
      expect(fires).toBe(1);            // timer torn down
      expect(host.list()).toEqual([]);
      expect(host.cancel(id)).toBe(false); // already gone
    } finally {
      vi.useRealTimers();
    }
  });

  it('ttlMs auto-cancels the monitor after the deadline', () => {
    vi.useFakeTimers();
    try {
      const host = new InMemoryTriggerHost();
      let fires = 0;
      host.arm({ label: 'm', source: createIntervalSource(1000), onFire: () => { fires++; }, recurring: true, maxFires: 100, ttlMs: 2500, now: 0 });
      vi.advanceTimersByTime(10_000);
      expect(fires).toBe(2);            // only ticks before ttl (1000, 2000)
      expect(host.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/contracts && pnpm vitest run src/__tests__/trigger.test.ts -t "createIntervalSource|TriggerHost"`
Expected: FAIL — `createIntervalSource`/`InMemoryTriggerHost` not exported.

- [ ] **Step 3: Implement in `trigger.ts`**

Append to `packages/contracts/src/trigger.ts`:

```ts
/** A subscribable event source. The source decides when events fire. */
export interface EventSource {
  subscribe(onEvent: () => void): () => void;
  /** Tear down any backing resource (timer, watcher). Optional. */
  stop?(): void;
}

/** A clock source: fires every intervalMs. Timer is unref'd so it never keeps
 *  the process alive. */
export function createIntervalSource(intervalMs: number): EventSource {
  const listeners = new Set<() => void>();
  const timer = setInterval(() => {
    for (const l of [...listeners]) l();
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return {
    subscribe(onEvent) {
      listeners.add(onEvent);
      return () => listeners.delete(onEvent);
    },
    stop() {
      clearInterval(timer);
      listeners.clear();
    },
  };
}

export interface MonitorSnapshot {
  id: string;
  label: string;
  createdAt: number;
  fires: number;
}

/**
 * Owns armed triggers so they survive across agent turns and can be listed and
 * cancelled. Generic over EventSource — the same host serves timer/task/stream
 * sources. One instance per agent runtime (injected on ToolContext.triggers).
 */
export interface TriggerHost {
  arm(spec: {
    label: string;
    source: EventSource;
    isSatisfied?: () => boolean;
    onFire: () => void;
    recurring?: boolean;
    maxFires?: number;
    ttlMs?: number;
    now: number;
  }): string;
  cancel(id: string): boolean;
  list(): MonitorSnapshot[];
}

export class InMemoryTriggerHost implements TriggerHost {
  private seq = 0;
  private readonly monitors = new Map<string, { label: string; createdAt: number; fires: number; teardown: () => void }>();

  arm(spec: {
    label: string;
    source: EventSource;
    isSatisfied?: () => boolean;
    onFire: () => void;
    recurring?: boolean;
    maxFires?: number;
    ttlMs?: number;
    now: number;
  }): string {
    const id = `mon-${++this.seq}`;
    let ttlTimer: ReturnType<typeof setTimeout> | null = null;

    const entry = { label: spec.label, createdAt: spec.now, fires: 0, teardown: () => {} };

    const armed = armTrigger({
      subscribe: spec.source.subscribe,
      isSatisfied: spec.isSatisfied ?? (() => true),
      onFire: () => {
        entry.fires++;
        spec.onFire();
      },
      recurring: spec.recurring,
      maxFires: spec.maxFires,
    });

    const teardown = () => {
      armed.cancel();
      spec.source.stop?.();
      if (ttlTimer) { clearTimeout(ttlTimer); ttlTimer = null; }
      this.monitors.delete(id);
    };
    entry.teardown = teardown;
    this.monitors.set(id, entry);

    if (spec.ttlMs && spec.ttlMs > 0) {
      ttlTimer = setTimeout(teardown, spec.ttlMs);
      (ttlTimer as { unref?: () => void }).unref?.();
    }

    // A one-shot that fired immediately is already done — drop it.
    if (armed.firedImmediately && !spec.recurring) teardown();
    // A recurring monitor that already hit maxFires via immediate fire: armTrigger
    // stops it, but we still need to remove it from the map once it can't fire again.
    return id;
  }

  cancel(id: string): boolean {
    const entry = this.monitors.get(id);
    if (!entry) return false;
    entry.teardown();
    return true;
  }

  list(): MonitorSnapshot[] {
    return Array.from(this.monitors.entries()).map(([id, e]) => ({
      id, label: e.label, createdAt: e.createdAt, fires: e.fires,
    }));
  }
}
```

> Note on maxFires auto-removal: `armTrigger` stops firing at `maxFires`, but the host must also remove the monitor from `list()` once it can no longer fire. Implement this by having `onFire` check the cap: after incrementing, if `spec.recurring && spec.maxFires && entry.fires >= spec.maxFires`, call `teardown()`. Add that to the `onFire` closure:
> ```ts
>       onFire: () => {
>         entry.fires++;
>         spec.onFire();
>         if (spec.maxFires && entry.fires >= spec.maxFires) teardown();
>       },
> ```
> (This makes the "auto-drops from list after maxFires" test pass. `teardown` is defined below `armed`, so hoist its declaration: declare `let teardown: () => void;` before `armTrigger`, assign after.)

- [ ] **Step 3b: Fix declaration order**

Because `onFire` references `teardown` which is defined after `armTrigger`, restructure: declare `let teardown: () => void = () => {};` before the `armTrigger` call, and assign the real `teardown` (and `entry.teardown`) after. Final shape:

```ts
  arm(spec): string {
    const id = `mon-${++this.seq}`;
    let ttlTimer: ReturnType<typeof setTimeout> | null = null;
    const entry = { label: spec.label, createdAt: spec.now, fires: 0, teardown: () => {} };
    let teardown: () => void = () => {};

    const armed = armTrigger({
      subscribe: spec.source.subscribe,
      isSatisfied: spec.isSatisfied ?? (() => true),
      onFire: () => {
        entry.fires++;
        spec.onFire();
        if (spec.maxFires && entry.fires >= spec.maxFires) teardown();
      },
      recurring: spec.recurring,
      maxFires: spec.maxFires,
    });

    teardown = () => {
      armed.cancel();
      spec.source.stop?.();
      if (ttlTimer) { clearTimeout(ttlTimer); ttlTimer = null; }
      this.monitors.delete(id);
    };
    entry.teardown = teardown;
    this.monitors.set(id, entry);

    if (spec.ttlMs && spec.ttlMs > 0) {
      ttlTimer = setTimeout(teardown, spec.ttlMs);
      (ttlTimer as { unref?: () => void }).unref?.();
    }
    if (armed.firedImmediately && !spec.recurring) teardown();
    return id;
  }
```

- [ ] **Step 4: Add `ToolContext.triggers` + exports**

In `packages/contracts/src/tool.ts`, update the trigger import and add the field. Change the existing background-task import line to also bring the host type:
```ts
import type { BackgroundTaskRegistry, BackgroundTaskResult } from './background-task.js';
import type { TriggerHost } from './trigger.js';
```
In `ToolContext`, after `deliverResult?: ...`, add:
```ts
  /** Per-runtime trigger host: owns armed monitors (timer/event triggers) so
   *  they survive across turns and can be listed/cancelled. Undefined when the
   *  runtime doesn't support monitors. */
  triggers?: TriggerHost;
```

In `packages/contracts/src/index.ts`, extend the trigger export block:
```ts
export type { TriggerSpec, ArmedTrigger, EventSource, MonitorSnapshot, TriggerHost } from './trigger.js';
export { armTrigger, createIntervalSource, InMemoryTriggerHost } from './trigger.js';
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd packages/contracts && pnpm vitest run src/__tests__/trigger.test.ts && pnpm build`
Expected: all trigger tests PASS (4 from Phase 0 + new); `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/trigger.ts packages/contracts/src/tool.ts packages/contracts/src/index.ts packages/contracts/src/__tests__/trigger.test.ts
git commit -m "feat(contracts): interval EventSource + InMemoryTriggerHost on the trigger spine"
```

---

### Task 2: core — own + inject a `TriggerHost`

**Files:**
- Modify: `packages/core/src/execution-harness.ts`
- Test: `packages/core/src/__tests__/execution-harness.background-tasks.test.ts`

**Interfaces:**
- Consumes: `InMemoryTriggerHost`, `TriggerHost` from `@dongkseo/contracts`.
- Produces: `LocalExecutionHarnessOptions.triggers?: TriggerHost`; harness injects `ctx.triggers` (defaults to a per-harness `InMemoryTriggerHost`, surviving across `execute()` calls).

- [ ] **Step 1: Write the failing test**

Append a test to `packages/core/src/__tests__/execution-harness.background-tasks.test.ts` (it already has `probeTool`/`probeArchitecture`/`nullLLM`/`baseCtx`):

```ts
  it('injects a triggers host into the tool ToolContext', async () => {
    const captured: { ctx?: ToolContext } = {};
    const tools = new CoreToolExecutor({ tools: [probeTool(captured)], context: baseCtx });
    const harness = new LocalExecutionHarness({ architecture: probeArchitecture(), llm: nullLLM, tools });
    for await (const _ev of harness.execute({ prompt: 'go' })) { /* drain */ }
    expect(captured.ctx?.triggers).toBeDefined();
    expect(typeof captured.ctx?.triggers?.arm).toBe('function');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run src/__tests__/execution-harness.background-tasks.test.ts -t "triggers host"`
Expected: FAIL — `captured.ctx?.triggers` is undefined.

- [ ] **Step 3: Wire it**

In `packages/core/src/execution-harness.ts`:

Add to the contracts value import (the `import { InMemoryBackgroundTaskRegistry } from '@dongkseo/contracts';` line):
```ts
import { InMemoryBackgroundTaskRegistry, InMemoryTriggerHost } from '@dongkseo/contracts';
```
Add to the type import block: `TriggerHost`.

In `LocalExecutionHarnessOptions`, after `deliverResult?: ...`:
```ts
  /** Trigger host injected into every tool ToolContext. Defaults to a per-harness InMemoryTriggerHost. */
  triggers?: TriggerHost;
```
Add a class field (after `private readonly deliverResult?...`):
```ts
  private readonly triggers: TriggerHost;
```
In the constructor (after `this.deliverResult = options.deliverResult;`):
```ts
    this.triggers = options.triggers ?? new InMemoryTriggerHost();
```
In the `withContext` injection block (next to `backgroundTasks`/`deliverResult`):
```ts
          triggers: this.triggers,
```

- [ ] **Step 4: Run test + typecheck**

Run: `cd packages/core && pnpm vitest run src/__tests__/execution-harness.background-tasks.test.ts && pnpm build`
Expected: all PASS; `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/execution-harness.ts packages/core/src/__tests__/execution-harness.background-tasks.test.ts
git commit -m "feat(core): inject a TriggerHost into ToolContext"
```

---

### Task 3: tools — `schedule_monitor` / `cancel_monitor` / `list_monitors`

**Files:**
- Create: `packages/tools/src/builtin/schedule-monitor.ts`
- Modify: `packages/tools/src/builtin/index.ts`
- Test: `packages/tools/src/__tests__/schedule-monitor.test.ts`

**Interfaces:**
- Consumes: `ctx.triggers` (`TriggerHost`), `ctx.steerSelf`, `ctx.deliverResult`, `createIntervalSource` from contracts.
- Produces: `createScheduleMonitorTool()`, `createCancelMonitorTool()`, `createListMonitorsTool()` → `ToolDefinition`s named `schedule_monitor` / `cancel_monitor` / `list_monitors`.

- [ ] **Step 1: Write the failing test**

Create `packages/tools/src/__tests__/schedule-monitor.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createScheduleMonitorTool, createCancelMonitorTool, createListMonitorsTool } from '../builtin/schedule-monitor.js';
import { InMemoryTriggerHost } from '@dongkseo/contracts';
import type { ToolContext } from '@dongkseo/contracts';

function ctx(host: InMemoryTriggerHost, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    tenantId: 't', workdir: '/tmp', secrets: { get: async () => undefined },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    triggers: host, ...extra,
  } as ToolContext;
}

describe('schedule_monitor', () => {
  it('arms a recurring monitor that wakes via steerSelf on each tick (bounded by max_fires)', async () => {
    vi.useFakeTimers();
    try {
      const host = new InMemoryTriggerHost();
      const woke: string[] = [];
      const tool = createScheduleMonitorTool();
      const res = await tool.execute('s1',
        { prompt: 'check the queue', every_ms: 1000, max_fires: 2 },
        ctx(host, { steerSelf: (m: string) => { woke.push(m); return true; } }));
      expect(res.type).toBe('text');
      vi.advanceTimersByTime(5000);
      expect(woke).toHaveLength(2);          // capped at max_fires
      expect(woke[0]).toContain('check the queue');
    } finally {
      vi.useRealTimers();
    }
  });

  it('floors the interval at 1000ms and requires a bound', async () => {
    const host = new InMemoryTriggerHost();
    const tool = createScheduleMonitorTool();
    const tooFast = await tool.execute('s2', { prompt: 'x', every_ms: 10, max_fires: 1 }, ctx(host));
    // accepted but floored — no throw; just assert it armed
    expect(tooFast.type).toBe('text');
    const unbounded = await tool.execute('s3', { prompt: 'x', every_ms: 1000 }, ctx(host));
    expect(unbounded.type).toBe('error'); // neither max_fires nor ttl_ms → rejected
  });

  it('errors when the runtime has no trigger host', async () => {
    const tool = createScheduleMonitorTool();
    const res = await tool.execute('s4', { prompt: 'x', every_ms: 1000, max_fires: 1 },
      { tenantId: 't', workdir: '/tmp', secrets: { get: async () => undefined }, logger: { info() {}, warn() {}, error() {} } } as ToolContext);
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toMatch(/not supported/i);
  });

  it('list_monitors shows armed monitors; cancel_monitor stops one', async () => {
    vi.useFakeTimers();
    try {
      const host = new InMemoryTriggerHost();
      const schedule = createScheduleMonitorTool();
      const list = createListMonitorsTool();
      const cancel = createCancelMonitorTool();
      await schedule.execute('s5', { prompt: 'watch', every_ms: 1000, max_fires: 100 }, ctx(host));

      const listed = await list.execute('l1', {}, ctx(host));
      expect(listed.type).toBe('text');
      const monitors = JSON.parse((listed as { text: string }).text);
      expect(monitors).toHaveLength(1);
      const id = monitors[0].id;

      const cancelled = await cancel.execute('c1', { monitor_id: id }, ctx(host));
      expect(cancelled.type).toBe('text');
      expect(host.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tools && pnpm vitest run src/__tests__/schedule-monitor.test.ts`
Expected: FAIL — module/exports missing.

- [ ] **Step 3: Implement `schedule-monitor.ts`**

Create `packages/tools/src/builtin/schedule-monitor.ts`:

```ts
/**
 * schedule_monitor / cancel_monitor / list_monitors — agent-set recurring
 * self-wake. The agent arms "every N ms, wake me with this prompt to check
 * something". Rides the Phase 0 armTrigger spine via ctx.triggers (TriggerHost)
 * and the existing ctx.steerSelf / ctx.deliverResult wake channels.
 *
 * Guardrails: interval floored at 1000ms; a monitor MUST be bounded by max_fires
 * (default 10) and/or ttl_ms — no unbounded self-wake.
 */

import type { ToolContext, ToolDefinition, ToolResult } from '@dongkseo/contracts';
import { textResult, errorResult, createIntervalSource } from '@dongkseo/contracts';

const MIN_INTERVAL_MS = 1000;
const DEFAULT_MAX_FIRES = 10;

export function createScheduleMonitorTool(): ToolDefinition {
  return {
    name: 'schedule_monitor',
    description:
      'Arm a recurring self-wake: every N ms you are notified with a prompt to ' +
      're-check something (non-blocking). Bounded by max_fires (default 10) and/or ' +
      'ttl_ms. Use cancel_monitor to stop early, list_monitors to see active ones.',
    parameters: {
      type: 'object',
      required: ['prompt', 'every_ms'],
      properties: {
        prompt: { type: 'string', description: 'What to check / why you are being woken.' },
        every_ms: { type: 'number', description: 'Interval in ms (floored at 1000).' },
        max_fires: { type: 'number', description: 'Stop after this many wakes (default 10).' },
        ttl_ms: { type: 'number', description: 'Auto-stop after this many ms.' },
        label: { type: 'string', description: 'Optional human label for list_monitors.' },
      },
    } as unknown as Record<string, unknown>,
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    async execute(_callId: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      const host = ctx.triggers;
      if (!host) return errorResult('Monitors are not supported in this runtime.');
      const input = rawInput as { prompt?: unknown; every_ms?: unknown; max_fires?: unknown; ttl_ms?: unknown; label?: unknown };
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (!prompt) return errorResult('prompt is required.');
      const everyMs = Math.max(MIN_INTERVAL_MS, typeof input.every_ms === 'number' ? input.every_ms : 0);
      const maxFires = typeof input.max_fires === 'number' && input.max_fires > 0 ? Math.floor(input.max_fires) : undefined;
      const ttlMs = typeof input.ttl_ms === 'number' && input.ttl_ms > 0 ? input.ttl_ms : undefined;
      if (maxFires === undefined && ttlMs === undefined) {
        return errorResult('A monitor must be bounded: provide max_fires and/or ttl_ms.');
      }
      const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim() : prompt.slice(0, 40);
      const cap = maxFires ?? DEFAULT_MAX_FIRES;

      let fires = 0;
      const fire = () => {
        fires++;
        const msg = `[monitor "${label}"] tick #${fires}: ${prompt}`;
        if (ctx.steerSelf?.(msg)) return;
        if (ctx.deliverResult) {
          void ctx.deliverResult({ taskId: `monitor:${label}`, kind: 'monitor', label, content: msg, isError: false });
          return;
        }
        ctx.logger.warn('schedule_monitor.wake_dropped', { label, reason: 'no steerSelf and no deliverResult' });
      };

      const id = host.arm({
        label,
        source: createIntervalSource(everyMs),
        onFire: fire,
        recurring: true,
        maxFires: cap,
        ttlMs,
        now: Date.now(),
      });

      const bound = [maxFires ? `${maxFires} fires` : null, ttlMs ? `${ttlMs}ms ttl` : null].filter(Boolean).join(', ');
      return textResult(`Armed monitor "${label}" (id ${id}) every ${everyMs}ms, bounded by ${bound}. Cancel with cancel_monitor.`);
    },
  };
}

export function createCancelMonitorTool(): ToolDefinition {
  return {
    name: 'cancel_monitor',
    description: 'Stop a recurring monitor by its id (from schedule_monitor / list_monitors).',
    parameters: {
      type: 'object',
      required: ['monitor_id'],
      properties: { monitor_id: { type: 'string', description: 'Monitor id.' } },
    } as unknown as Record<string, unknown>,
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: true,
    async execute(_callId: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      const host = ctx.triggers;
      if (!host) return errorResult('Monitors are not supported in this runtime.');
      const id = (rawInput as { monitor_id?: unknown }).monitor_id;
      if (typeof id !== 'string' || !id.trim()) return errorResult('monitor_id is required.');
      return host.cancel(id.trim())
        ? textResult(`Cancelled monitor ${id.trim()}.`)
        : errorResult(`No active monitor with id ${id.trim()}.`);
    },
  };
}

export function createListMonitorsTool(): ToolDefinition {
  return {
    name: 'list_monitors',
    description: 'List active recurring monitors you armed, with id / label / fire count.',
    parameters: { type: 'object', properties: {} } as unknown as Record<string, unknown>,
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    async execute(_callId: string, _rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      const host = ctx.triggers;
      if (!host) return errorResult('Monitors are not supported in this runtime.');
      const monitors = host.list();
      if (monitors.length === 0) return textResult('No active monitors.');
      return textResult(JSON.stringify(monitors));
    },
  };
}
```

- [ ] **Step 4: Export from `builtin/index.ts`**

In `packages/tools/src/builtin/index.ts`, after the background-tasks export block, add:
```ts
export {
  createScheduleMonitorTool,
  createCancelMonitorTool,
  createListMonitorsTool,
} from './schedule-monitor.js';
```

- [ ] **Step 5: Run tests + whole-repo build + suite**

Run: `cd packages/tools && pnpm vitest run src/__tests__/schedule-monitor.test.ts`
Expected: PASS (4 tests).

Run: `cd /Users/dongkseo/Project/Nexora && pnpm build && pnpm test`
Expected: all `tsc` clean; all turbo test tasks PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/tools/src/builtin/schedule-monitor.ts packages/tools/src/builtin/index.ts packages/tools/src/__tests__/schedule-monitor.test.ts
git commit -m "feat(tools): schedule_monitor/cancel_monitor/list_monitors — recurring self-wake on the trigger spine"
```

---

## Self-Review

**1. Spec coverage (architecture doc Phase 1):** timer source via armTrigger → `createIntervalSource` + host (Task 1). Self-scheduling/recurring monitor → `schedule_monitor` (Task 3). Guardrails (max_fires/ttl/interval floor) → Task 1 host + Task 3 tool. Wake via steerSelf/deliverResult → Task 3 `fire()`. TriggerHost survives turns (harness-owned) → Task 2. Cancel/list → Task 3 tools. ✓ Asleep-into-new-turn re-invocation → explicitly deferred (rides deliverResult, app-wired). ✓

**2. Placeholder scan:** No TBD/TODO. Step 3/3b explicitly resolve the `teardown` declaration-order detail with full code. ✓

**3. Type consistency:** `TriggerHost.arm(spec)` signature identical across contracts def/impl (Task 1), harness field type (Task 2), and tool usage (Task 3). `createIntervalSource(ms): EventSource` consistent. `MonitorSnapshot {id,label,createdAt,fires}` consistent between impl and `list_monitors`/test. `ctx.triggers` field consistent across tool.ts, harness injection, tool reads. Tool names `schedule_monitor`/`cancel_monitor`/`list_monitors` + params (`prompt`,`every_ms`,`max_fires`,`ttl_ms`,`monitor_id`) consistent between impl and tests. ✓

---

## Next cycle (not this plan)

- **Phase 2** — stream source (background-exec → AuditStore → regex predicate): shell monitoring.
- **App wiring** — `deliverResult` that starts a new turn (adapter), making idle-agent self-wake fully autonomous.
