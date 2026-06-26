# `watch_task` Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a non-blocking built-in tool `watch_task` that lets an agent arm a one-shot trigger on one or more background tasks; when they settle (mode `all`/`any`), a status message is folded into the agent's turn via the existing `steerSelf`/`deliverResult` channels.

**Architecture:** Add a `subscribe` notification to the `BackgroundTaskRegistry` (contracts) so the tool can react to terminal transitions. The tool reads everything else (registry, `steerSelf`, `deliverResult`) from the `ToolContext` the harness already injects — no core/harness change.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Vitest, pnpm + turbo.

## Global Constraints

- ESM `.js` import specifiers; no new deps.
- Per-package tests: `cd packages/<pkg> && pnpm vitest run <path>`. Whole-repo typecheck: `pnpm build` (root). Whole-repo tests: `pnpm test` (root).
- Non-blocking only (blocking is already an optional knob in the bg infra; a blocking watch would stall `executeBatch`'s sequential lane).
- One-shot `until`-join only. No `while…do`, no `done/error`-only filters, no output/progress DSL (YAGNI).
- Terminal = `done | error | cancelled`. The fired message reports each task's final status; the agent reads done-vs-error from it.
- contracts stays additive (new optional `subscribe`); listener errors are isolated so one bad listener can't break `settle`.
- Build green at every commit: contracts (Task 1, additive) → tools (Task 2).

---

## File Structure

- `packages/contracts/src/background-task.ts` — add `subscribe` to the `BackgroundTaskRegistry` interface and `InMemoryBackgroundTaskRegistry` (listener set + notify on `settle`/`cancel`).
- `packages/contracts/src/__tests__/background-task.test.ts` — add subscribe tests.
- `packages/tools/src/builtin/background-tasks.ts` — add `createWatchTaskTool` next to the other control tools.
- `packages/tools/src/builtin/index.ts` — export `createWatchTaskTool`.
- `packages/tools/src/__tests__/background-tasks.test.ts` — add watch_task tests.

---

### Task 1: contracts — registry `subscribe`

**Files:**
- Modify: `packages/contracts/src/background-task.ts`
- Test: `packages/contracts/src/__tests__/background-task.test.ts`

**Interfaces:**
- Produces: `BackgroundTaskRegistry.subscribe(listener: (taskId: string, status: BackgroundTaskStatus) => void): () => void`. Fires AFTER a terminal transition (`settle`/`cancel`); `register` does not fire. Returns an unsubscribe fn.

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/__tests__/background-task.test.ts` (inside the existing `describe`):

```ts
  it('subscribe fires on settle with the new terminal status', () => {
    const r = reg();
    const seen: Array<[string, string]> = [];
    r.subscribe((taskId, status) => seen.push([taskId, status]));
    r.register({ taskId: 't1', kind: 'k', label: 'a', startedAt: 1, abort: () => {} });
    expect(seen).toEqual([]); // register does not fire
    r.settle('t1', 'done', 5);
    expect(seen).toEqual([['t1', 'done']]);
  });

  it('subscribe fires on cancel with status cancelled', () => {
    const r = reg();
    const seen: Array<[string, string]> = [];
    r.register({ taskId: 't1', kind: 'k', label: 'a', startedAt: 1, abort: () => {} });
    r.subscribe((taskId, status) => seen.push([taskId, status]));
    r.cancel('t1');
    expect(seen).toEqual([['t1', 'cancelled']]);
  });

  it('does not fire for a no-op settle (already settled / unknown)', () => {
    const r = reg();
    r.register({ taskId: 't1', kind: 'k', label: 'a', startedAt: 1, abort: () => {} });
    r.settle('t1', 'done', 5);
    const seen: string[] = [];
    r.subscribe((taskId) => seen.push(taskId));
    r.settle('t1', 'error', 9); // no-op (already settled)
    r.settle('nope', 'done', 1); // no-op (unknown)
    expect(seen).toEqual([]);
  });

  it('unsubscribe stops further notifications', () => {
    const r = reg();
    const seen: string[] = [];
    const off = r.subscribe((taskId) => seen.push(taskId));
    r.register({ taskId: 't1', kind: 'k', label: 'a', startedAt: 1, abort: () => {} });
    off();
    r.settle('t1', 'done', 5);
    expect(seen).toEqual([]);
  });

  it('isolates a throwing listener so settle still notifies others', () => {
    const r = reg();
    const seen: string[] = [];
    r.subscribe(() => { throw new Error('bad listener'); });
    r.subscribe((taskId) => seen.push(taskId));
    r.register({ taskId: 't1', kind: 'k', label: 'a', startedAt: 1, abort: () => {} });
    expect(() => r.settle('t1', 'done', 5)).not.toThrow();
    expect(seen).toEqual(['t1']);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/contracts && pnpm vitest run src/__tests__/background-task.test.ts -t subscribe`
Expected: FAIL — `r.subscribe is not a function`.

- [ ] **Step 3: Add `subscribe` to the interface**

In `packages/contracts/src/background-task.ts`, add to the `BackgroundTaskRegistry` interface (after `get(...)`):

```ts
  /** Subscribe to terminal state transitions (settle/cancel). Returns an
   *  unsubscribe fn. Fires AFTER the task's status is updated; register does not fire. */
  subscribe(listener: (taskId: string, status: BackgroundTaskStatus) => void): () => void;
```

- [ ] **Step 4: Implement in `InMemoryBackgroundTaskRegistry`**

Add a listener set field (after `private readonly tasks = ...`):

```ts
  private readonly listeners = new Set<(taskId: string, status: BackgroundTaskStatus) => void>();
```

Add the method (after `get(...)`):

```ts
  subscribe(listener: (taskId: string, status: BackgroundTaskStatus) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(taskId: string, status: BackgroundTaskStatus): void {
    for (const listener of this.listeners) {
      try {
        listener(taskId, status);
      } catch {
        // Isolate a bad listener — it must not break settle/cancel.
      }
    }
  }
```

In `settle(...)`, after `this.pruneSettled();` add:
```ts
    this.notify(taskId, status);
```

In `cancel(...)`, after `this.pruneSettled();` (and before `return true;`) add:
```ts
    this.notify(taskId, 'cancelled');
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd packages/contracts && pnpm vitest run src/__tests__/background-task.test.ts && pnpm build`
Expected: all tests PASS (6 original + 5 new = 11); `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/background-task.ts packages/contracts/src/__tests__/background-task.test.ts
git commit -m "feat(contracts): BackgroundTaskRegistry.subscribe for terminal transitions"
```

---

### Task 2: tools — `createWatchTaskTool`

**Files:**
- Modify: `packages/tools/src/builtin/background-tasks.ts` (add the tool)
- Modify: `packages/tools/src/builtin/index.ts` (export)
- Test: `packages/tools/src/__tests__/background-tasks.test.ts`

**Interfaces:**
- Consumes: `ctx.backgroundTasks` (`BackgroundTaskRegistry` with `subscribe`/`get` from Task 1), `ctx.steerSelf`, `ctx.deliverResult`, `ctx.logger`.
- Produces: `createWatchTaskTool(): ToolDefinition` (tool name `watch_task`, params `{ task_ids: string[], mode?: 'all'|'any', message?: string }`).

- [ ] **Step 1: Write the failing test**

Append to `packages/tools/src/__tests__/background-tasks.test.ts` a new `describe`. (The file already imports `InMemoryBackgroundTaskRegistry` from `@dongkseo/contracts` and `vi` from vitest; add `createWatchTaskTool` to the `../builtin/background-tasks.js` import.)

```ts
describe('watch_task', () => {
  function ctxWith(reg: InMemoryBackgroundTaskRegistry, extra: Partial<ToolContext> = {}): ToolContext {
    return { ...baseCtx(), backgroundTasks: reg, ...extra } as ToolContext;
  }
  function addTask(reg: InMemoryBackgroundTaskRegistry, id: string) {
    reg.register({ taskId: id, kind: 'subagent', label: id, startedAt: 1, abort: () => {} });
  }

  it('fires via steerSelf when all watched tasks settle (mode=all, default)', async () => {
    const reg = new InMemoryBackgroundTaskRegistry();
    addTask(reg, 't1'); addTask(reg, 't2');
    const steered: string[] = [];
    const tool = createWatchTaskTool();
    const res = await tool.execute('w1', { task_ids: ['t1', 't2'] },
      ctxWith(reg, { steerSelf: (m: string) => { steered.push(m); return true; } }));
    expect(res.type).toBe('text');
    if (res.type === 'text') expect(res.text).toMatch(/Watching 2 task/);

    reg.settle('t1', 'done', 10);
    expect(steered).toEqual([]); // not all terminal yet
    reg.settle('t2', 'error', 11);
    expect(steered).toHaveLength(1);
    expect(steered[0]).toContain('t1=done');
    expect(steered[0]).toContain('t2=error');
  });

  it('mode=any fires on the first settle', async () => {
    const reg = new InMemoryBackgroundTaskRegistry();
    addTask(reg, 't1'); addTask(reg, 't2');
    const steered: string[] = [];
    const tool = createWatchTaskTool();
    await tool.execute('w2', { task_ids: ['t1', 't2'], mode: 'any' },
      ctxWith(reg, { steerSelf: (m: string) => { steered.push(m); return true; } }));
    reg.settle('t1', 'done', 10);
    expect(steered).toHaveLength(1);
  });

  it('fires immediately if already satisfied', async () => {
    const reg = new InMemoryBackgroundTaskRegistry();
    addTask(reg, 't1');
    reg.settle('t1', 'done', 10);
    const steered: string[] = [];
    const tool = createWatchTaskTool();
    const res = await tool.execute('w3', { task_ids: ['t1'] },
      ctxWith(reg, { steerSelf: (m: string) => { steered.push(m); return true; } }));
    expect(steered).toHaveLength(1);
    if (res.type === 'text') expect(res.text).toMatch(/already settled/);
  });

  it('falls back to deliverResult when steerSelf returns false', async () => {
    const reg = new InMemoryBackgroundTaskRegistry();
    addTask(reg, 't1');
    const delivered: Array<{ content: string; isError: boolean }> = [];
    const tool = createWatchTaskTool();
    await tool.execute('w4', { task_ids: ['t1'] },
      ctxWith(reg, { steerSelf: () => false, deliverResult: (r) => { delivered.push(r); } }));
    reg.settle('t1', 'error', 10);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].isError).toBe(true); // a watched task errored
  });

  it('rejects unknown task ids without arming', async () => {
    const reg = new InMemoryBackgroundTaskRegistry();
    addTask(reg, 't1');
    const tool = createWatchTaskTool();
    const res = await tool.execute('w5', { task_ids: ['t1', 'ghost'] }, ctxWith(reg));
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toContain('ghost');
  });

  it('errors when the runtime has no background-task registry', async () => {
    const tool = createWatchTaskTool();
    const res = await tool.execute('w6', { task_ids: ['t1'] }, baseCtx());
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toMatch(/not supported/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tools && pnpm vitest run src/__tests__/background-tasks.test.ts -t watch_task`
Expected: FAIL — `createWatchTaskTool` is not exported.

- [ ] **Step 3: Implement `createWatchTaskTool`**

In `packages/tools/src/builtin/background-tasks.ts`, add (after `createCancelTasksTool`). Note the import must also bring `BackgroundTaskStatus` — update the existing type import line to include it:

Change the import line to:
```ts
import type { BackgroundTaskRegistry, BackgroundTaskStatus, ToolContext, ToolDefinition, ToolResult } from '@dongkseo/contracts';
```

Then append:

```ts
/**
 * `watch_task` — arm a non-blocking, one-shot trigger on background tasks.
 * When the watched tasks settle (mode 'all' or 'any'), a status message is
 * folded into the agent's turn via steerSelf, or delivered as a follow-up via
 * deliverResult. Rides the ToolContext primitives the runtime injects.
 */
export function createWatchTaskTool(): ToolDefinition {
  return {
    name: 'watch_task',
    description:
      'Get notified (non-blocking) when background tasks settle. Provide task_ids ' +
      'and optionally mode ("all" — default — or "any"). Returns immediately; you ' +
      'are notified with each task\'s final status (done/error/cancelled) when the ' +
      'condition is met. Use task ids from check_tasks / a launched task.',
    parameters: {
      type: 'object',
      required: ['task_ids'],
      properties: {
        task_ids: { type: 'array', items: { type: 'string' }, description: 'Background task ids to watch.' },
        mode: { type: 'string', enum: ['all', 'any'], description: 'Fire when all (default) or any of the tasks settle.' },
        message: { type: 'string', description: 'Optional note included in the notification.' },
      },
    } as unknown as Record<string, unknown>,
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    async execute(_callId: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      const registry: BackgroundTaskRegistry | undefined = ctx.backgroundTasks;
      if (!registry) return errorResult('Background tasks are not supported in this runtime.');

      const input = rawInput as { task_ids?: unknown; mode?: unknown; message?: unknown };
      const taskIds = Array.isArray(input.task_ids)
        ? input.task_ids.filter((x): x is string => typeof x === 'string')
        : [];
      if (taskIds.length === 0) return errorResult('task_ids must be a non-empty array of task ids.');
      const mode: 'all' | 'any' = input.mode === 'any' ? 'any' : 'all';
      const note = typeof input.message === 'string' ? input.message : '';

      const unknownIds = taskIds.filter((id) => !registry.get(id));
      if (unknownIds.length > 0) {
        return errorResult(`Unknown task id(s): ${unknownIds.join(', ')}. Nothing to watch.`);
      }

      const statusOf = (id: string): BackgroundTaskStatus | 'gone' => registry.get(id)?.status ?? 'gone';
      const isTerminal = (id: string) => {
        const s = statusOf(id);
        return s !== 'running' && s !== 'gone';
      };
      const satisfied = () => (mode === 'all' ? taskIds.every(isTerminal) : taskIds.some(isTerminal));

      const fire = () => {
        const statuses = taskIds.map((id) => `${id}=${statusOf(id)}`).join(', ');
        const anyError = taskIds.some((id) => statusOf(id) === 'error');
        const msg = `[watch] tasks settled (mode=${mode}): ${statuses}.${note ? ' ' + note : ''}`;
        if (ctx.steerSelf?.(msg)) return;
        if (ctx.deliverResult) {
          void ctx.deliverResult({ taskId: `watch:${taskIds.join(',')}`, kind: 'watch', label: 'watch', content: msg, isError: anyError });
          return;
        }
        ctx.logger.warn('watch_task.notify_dropped', { taskIds, reason: 'no steerSelf and no deliverResult' });
      };

      if (satisfied()) {
        fire();
        return textResult(`Watched ${taskIds.length} task(s) — already settled; notified now.`);
      }

      const unsubscribe = registry.subscribe(() => {
        if (satisfied()) {
          unsubscribe();
          fire();
        }
      });
      return textResult(`Watching ${taskIds.length} task(s) (mode=${mode}); you'll be notified when they settle.`);
    },
  };
}
```

- [ ] **Step 4: Export from `builtin/index.ts`**

In `packages/tools/src/builtin/index.ts`, update the background-tasks export block:
```ts
export {
  createCheckTasksTool,
  createCancelTasksTool,
  createWatchTaskTool,
} from './background-tasks.js';
export type { TaskControlToolOptions } from './background-tasks.js';
```

- [ ] **Step 5: Run tests + whole-repo typecheck**

Run: `cd packages/tools && pnpm vitest run src/__tests__/background-tasks.test.ts`
Expected: PASS (existing + 6 new watch_task tests).

Run: `cd /Users/dongkseo/Project/Nexora && pnpm build`
Expected: all packages `tsc` clean.

- [ ] **Step 6: Run whole-repo test suite**

Run: `cd /Users/dongkseo/Project/Nexora && pnpm test`
Expected: all turbo test tasks PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/tools/src/builtin/background-tasks.ts packages/tools/src/builtin/index.ts packages/tools/src/__tests__/background-tasks.test.ts
git commit -m "feat(tools): watch_task — non-blocking agent-set triggers on background tasks"
```

---

## Self-Review

**1. Spec coverage:**
- Non-blocking arm-and-fire, one-shot → Task 2 (subscribe + immediate return). ✓
- mode all/any over multiple tasks → Task 2 `satisfied()`. ✓
- Fire via steerSelf → deliverResult → log+drop ladder → Task 2 `fire()`. ✓
- Per-task status in the message → Task 2 `statuses`. ✓
- Unknown-id rejection; no-registry error → Task 2. ✓
- Registry subscribe (settle/cancel, no-op silence, unsubscribe, listener isolation) → Task 1. ✓
- No core/harness change; contracts additive → both tasks. ✓
- Deferred (while-do, done/error filters, DSL) → not implemented. ✓

**2. Placeholder scan:** No TBD/TODO/vague steps. All code shown in full.

**3. Type consistency:** `subscribe(listener: (taskId, status: BackgroundTaskStatus) => void): () => void` identical in Task 1 interface, impl, and Task 2 consumption. `BackgroundTaskStatus` imported in both. `fire()` builds a `BackgroundTaskResult { taskId, kind, label, content, isError }` matching the contracts type. Tool name `watch_task`, params `task_ids`/`mode`/`message` consistent between impl and tests. ✓
