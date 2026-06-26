# Monitoring Triggers — Phase 2b (watch_output) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** `watch_output({ task_id, pattern })` — the runtime polls a background task's captured stdout/stderr and wakes the agent (steer/deliver) the first time the output matches a regex. The predicate runs in the runtime (non-LLM, zero token cost per poll); the agent is woken only on a match.

**Architecture:** Reuses everything: `ctx.backgroundTasks.get(id).readOutput()` (Phase 2a) for the content, `ctx.triggers` `TriggerHost` + `createIntervalSource` (Phase 1) for the poll loop, `armTrigger` predicate for the regex test. One-shot (`maxFires: 1`) so the host tears down the interval on first match; `fireOnArm: true` catches already-buffered matches; `ttl_ms` bounds a never-matching watch. No new contracts.

**Tech Stack:** TypeScript (ESM `.js`), Vitest (fake timers), pnpm + turbo.

## Global Constraints

- ESM `.js`; no new deps; no contract changes.
- `poll_ms` floored at 1000. A never-matching watch is bounded by `ttl_ms` (default 300000) — no unbounded poll.
- One-shot: fire on first match, then auto-stop (host teardown via `maxFires: 1`).
- Requires `ctx.triggers` and `ctx.backgroundTasks`; the task must have a `readOutput` handle (background-exec tasks do). Otherwise error.
- Wake via `ctx.steerSelf` → `ctx.deliverResult` → log+drop (same ladder as schedule_monitor).
- Build green at commit.

---

## File Structure

- `packages/tools/src/builtin/schedule-monitor.ts` — **modify**. Add `createWatchOutputTool`.
- `packages/tools/src/builtin/index.ts` — **modify**. Export it.
- `packages/tools/src/__tests__/schedule-monitor.test.ts` — **modify**. Add `watch_output` tests.

---

### Task 1: `watch_output` tool

**Files:**
- Modify: `packages/tools/src/builtin/schedule-monitor.ts`, `packages/tools/src/builtin/index.ts`
- Test: `packages/tools/src/__tests__/schedule-monitor.test.ts`

**Interfaces:**
- Consumes: `ctx.triggers` (`TriggerHost`), `ctx.backgroundTasks` (task `readOutput`), `createIntervalSource`, `ctx.steerSelf`/`ctx.deliverResult`.
- Produces: `createWatchOutputTool(): ToolDefinition` (name `watch_output`, params `task_id`, `pattern`, `poll_ms?`, `ttl_ms?`, `label?`).

- [ ] **Step 1: Write the failing test**

Append to `packages/tools/src/__tests__/schedule-monitor.test.ts`. Add `createWatchOutputTool` to the import from `../builtin/schedule-monitor.js`, and `InMemoryBackgroundTaskRegistry` is already imported (from `@dongkseo/contracts`). Add:

```ts
describe('watch_output', () => {
  function regCtx(reg: InMemoryBackgroundTaskRegistry, host: InMemoryTriggerHost, steer?: (m: string) => boolean): ToolContext {
    return {
      tenantId: 't', workdir: '/tmp', secrets: { get: async () => undefined },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      backgroundTasks: reg, triggers: host, steerSelf: steer,
    } as ToolContext;
  }

  it('fires when the pattern later appears in task output (one-shot, then tears down)', async () => {
    vi.useFakeTimers();
    try {
      const reg = new InMemoryBackgroundTaskRegistry();
      const host = new InMemoryTriggerHost();
      let out = 'starting build...';
      reg.register({ taskId: 't1', kind: 'bash', label: 'build', startedAt: 0, abort: () => {}, readOutput: () => out });
      const woke: string[] = [];
      const tool = createWatchOutputTool();
      const res = await tool.execute('w1', { task_id: 't1', pattern: 'ERROR', poll_ms: 1000 },
        regCtx(reg, host, (m) => { woke.push(m); return true; }));
      expect(res.type).toBe('text');

      vi.advanceTimersByTime(2000);
      expect(woke).toHaveLength(0);            // no match yet
      out = 'oops: ERROR: build failed';
      vi.advanceTimersByTime(1000);
      expect(woke).toHaveLength(1);
      expect(woke[0]).toContain('ERROR');
      expect(host.list()).toEqual([]);         // one-shot torn down
      vi.advanceTimersByTime(5000);
      expect(woke).toHaveLength(1);            // no re-fire
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires immediately if the output already matches', async () => {
    const reg = new InMemoryBackgroundTaskRegistry();
    const host = new InMemoryTriggerHost();
    reg.register({ taskId: 't2', kind: 'bash', label: 'b', startedAt: 0, abort: () => {}, readOutput: () => 'already ERROR here' });
    const woke: string[] = [];
    const tool = createWatchOutputTool();
    await tool.execute('w2', { task_id: 't2', pattern: 'ERROR' }, regCtx(reg, host, (m) => { woke.push(m); return true; }));
    expect(woke).toHaveLength(1);
  });

  it('rejects invalid regex / unknown task / output-less task / no runtime support', async () => {
    const reg = new InMemoryBackgroundTaskRegistry();
    const host = new InMemoryTriggerHost();
    reg.register({ taskId: 't3', kind: 'bash', label: 'b', startedAt: 0, abort: () => {} }); // no readOutput
    const tool = createWatchOutputTool();
    const noOut = await tool.execute('w3', { task_id: 't3', pattern: 'x' }, regCtx(reg, host));
    expect(noOut.type).toBe('error');
    const unknown = await tool.execute('w4', { task_id: 'ghost', pattern: 'x' }, regCtx(reg, host));
    expect(unknown.type).toBe('error');
    const badRe = await tool.execute('w5', { task_id: 't3', pattern: '(' }, regCtx(reg, host));
    expect(badRe.type).toBe('error');
    const noHost = await tool.execute('w6', { task_id: 't3', pattern: 'x' },
      { tenantId: 't', workdir: '/tmp', secrets: { get: async () => undefined }, logger: { info() {}, warn() {}, error() {} }, backgroundTasks: reg } as ToolContext);
    expect(noHost.type).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tools && pnpm vitest run src/__tests__/schedule-monitor.test.ts -t watch_output`
Expected: FAIL — `createWatchOutputTool` not exported.

- [ ] **Step 3: Implement `createWatchOutputTool`**

In `packages/tools/src/builtin/schedule-monitor.ts`, add `createIntervalSource` to the contracts import (it already imports `textResult, errorResult, createIntervalSource` — confirm `createIntervalSource` is present; it is used here for the first time, so add it):

```ts
import { textResult, errorResult, createIntervalSource } from '@dongkseo/contracts';
```
(already present from schedule_monitor — no change needed if so.)

Append:

```ts
const DEFAULT_WATCH_TTL_MS = 300_000;

export function createWatchOutputTool(): ToolDefinition {
  return {
    name: 'watch_output',
    description:
      'Watch a background task\'s output (stdout/stderr) and wake you the first time ' +
      'it matches a regex pattern (non-blocking, runtime-side — no token cost per check). ' +
      'One-shot. Bounded by ttl_ms (default 5min). Use the task_id from a run_in_background exec.',
    parameters: {
      type: 'object',
      required: ['task_id', 'pattern'],
      properties: {
        task_id: { type: 'string', description: 'Background task id (from check_tasks / a launched task).' },
        pattern: { type: 'string', description: 'JavaScript regex to match against the captured output.' },
        poll_ms: { type: 'number', description: 'Poll interval in ms (floored at 1000).' },
        ttl_ms: { type: 'number', description: 'Give up after this many ms (default 300000).' },
        label: { type: 'string', description: 'Optional label for list_monitors.' },
      },
    } as unknown as Record<string, unknown>,
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    async execute(_callId: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      const host = ctx.triggers;
      const registry = ctx.backgroundTasks;
      if (!host || !registry) return errorResult('Output monitors are not supported in this runtime.');
      const input = rawInput as { task_id?: unknown; pattern?: unknown; poll_ms?: unknown; ttl_ms?: unknown; label?: unknown };
      const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
      if (!taskId) return errorResult('task_id is required.');
      const patternStr = typeof input.pattern === 'string' ? input.pattern : '';
      if (!patternStr) return errorResult('pattern is required.');
      const task = registry.get(taskId);
      if (!task) return errorResult(`No task with id ${taskId}.`);
      if (!task.readOutput) return errorResult(`Task ${taskId} has no captured output to watch.`);
      let re: RegExp;
      try {
        re = new RegExp(patternStr);
      } catch (err) {
        return errorResult(`Invalid regex: ${err instanceof Error ? err.message : String(err)}`);
      }
      const pollMs = Math.max(MIN_INTERVAL_MS, typeof input.poll_ms === 'number' ? input.poll_ms : MIN_INTERVAL_MS);
      const ttlMs = typeof input.ttl_ms === 'number' && input.ttl_ms > 0 ? input.ttl_ms : DEFAULT_WATCH_TTL_MS;
      const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim() : `output~/${patternStr}/`;

      const readOutput = task.readOutput;
      const fire = () => {
        const tail = readOutput().slice(-500);
        const msg = `[watch_output ${taskId}] pattern /${patternStr}/ matched:\n…${tail}`;
        if (ctx.steerSelf?.(msg)) return;
        if (ctx.deliverResult) {
          void ctx.deliverResult({ taskId: `watch_output:${taskId}`, kind: 'watch_output', label, content: msg, isError: false });
          return;
        }
        ctx.logger.warn('watch_output.wake_dropped', { taskId, reason: 'no steerSelf and no deliverResult' });
      };

      const id = host.arm({
        label,
        source: createIntervalSource(pollMs),
        isSatisfied: () => re.test(readOutput()),
        onFire: fire,
        recurring: false,
        maxFires: 1,
        ttlMs,
        fireOnArm: true,
        now: Date.now(),
      });

      return textResult(`Watching task ${taskId} output for /${patternStr}/ (poll ${pollMs}ms, give up after ${ttlMs}ms, id ${id}). Cancel with cancel_monitor.`);
    },
  };
}
```

- [ ] **Step 4: Export it**

In `packages/tools/src/builtin/index.ts`, add `createWatchOutputTool` to the `./schedule-monitor.js` export block.

- [ ] **Step 5: Run tests + whole-repo build + suite**

Run: `cd packages/tools && pnpm vitest run src/__tests__/schedule-monitor.test.ts`
Expected: PASS (existing schedule_monitor + new watch_output).

Run: `cd /Users/dongkseo/Project/Nexora && pnpm build && pnpm test`
Expected: all `tsc` clean; all turbo test tasks PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/tools/src/builtin/schedule-monitor.ts packages/tools/src/builtin/index.ts packages/tools/src/__tests__/schedule-monitor.test.ts
git commit -m "feat(tools): watch_output — runtime-side regex trigger on background task output"
```

---

## Self-Review

**1. Coverage:** regex predicate over task output → `isSatisfied: () => re.test(readOutput())`. Runtime-side poll (no LLM) → `createIntervalSource` + host. One-shot + teardown → `maxFires: 1` (host tears down on fire). Already-buffered match → `fireOnArm: true`. Never-match bound → `ttl_ms` default. Cancel/list → reuses `cancel_monitor`/`list_monitors` (same host). Errors (no host/task/output, bad regex) → guards. ✓

**2. Placeholder scan:** No TBD/vague; full code. ✓

**3. Type consistency:** `host.arm({...maxFires, ttlMs, fireOnArm, now})` matches the `TriggerHost.arm` spec (Phase 1). `task.readOutput` from Phase 2a. Tool params consistent with tests. `MIN_INTERVAL_MS` reused from schedule-monitor.ts. ✓

---

## Next cycle (not this plan)

- **Push (not poll)** — background-exec emits an output-event so watch_output reacts without polling (needs a BackgroundTask output-event channel).
- **App wiring** — `deliverResult` → new turn for fully-idle wake.
