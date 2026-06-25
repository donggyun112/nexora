# Tool-Neutral Background-Task Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the background-task layer out of the subagent/delegate domain into a tool-neutral primitive any tool can use, wired through the real runtime (`LocalExecutionHarness`).

**Architecture:** Define generic background-task types + an in-memory registry impl in `@dongkseo/contracts` (the only package both `core` and `tools` depend on). Expose `backgroundTasks` (registry) and `deliverResult` (post-turn sink) on `ToolContext`, injected by `LocalExecutionHarness` the same way `onSuspend`/`steerSelf` already are. Relocate the control tools to a tool-neutral `background-tasks.ts` (`check_tasks`/`cancel_task`). `delegate` becomes one consumer that registers `kind:'subagent'` tasks; its external behavior is unchanged.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, pnpm + turbo workspaces.

## Global Constraints

- Language: TypeScript, ESM. Import paths use `.js` extension even for `.ts` sources.
- Test runner: Vitest. Per-package: `cd packages/<pkg> && pnpm vitest run <path>`. Whole repo: `pnpm test` from root (turbo). Whole-repo typecheck: `pnpm build` from root.
- No new package dependencies. The registry impl lives in `contracts` because `core` and `tools` both depend only on `@dongkseo/contracts` (verified); `tools` does NOT depend on `core`.
- Tool-neutral naming is mandatory: no `childName`/`capability`/`subagent` in the generic layer. Use `kind` (tool family, e.g. `'subagent'`) and `label` (human-readable name).
- Tool renames (no back-compat aliases — verified zero production consumers, only `delegate` + tests): `check_subagents`→`check_tasks`, `cancel_subagent`→`cancel_task`.
- `delegate`'s external behavior MUST stay identical (launched message, fold-back via steerSelf, post-turn deliverResult, cancel). Covered by the existing (renamed) tests.
- `Date.now()` is allowed in production code (only forbidden inside Workflow scripts).
- Build must stay green at every commit: contracts (additive) → core (additive) → tools (atomic rename/retype).

---

## File Structure

- `packages/contracts/src/background-task.ts` — **new**. Generic types (`BackgroundTaskStatus`, `BackgroundTask`, `BackgroundTaskSnapshot`, `BackgroundTaskResult`), the `BackgroundTaskRegistry` interface, and the `InMemoryBackgroundTaskRegistry` impl.
- `packages/contracts/src/tool.ts` — **modify**. Add `backgroundTasks?` + `deliverResult?` to `ToolContext`.
- `packages/contracts/src/index.ts` — **modify**. Export the new module.
- `packages/contracts/src/__tests__/background-task.test.ts` — **new**. Registry unit tests.
- `packages/core/src/execution-harness.ts` — **modify**. New options + inject into ToolContext.
- `packages/core/src/__tests__/execution-harness.background-tasks.test.ts` — **new**. Injection test.
- `packages/tools/src/builtin/background-subagents.ts` → `packages/tools/src/builtin/background-tasks.ts` — **rename + rewrite**. Control tools only (registry now from contracts).
- `packages/tools/src/builtin/delegate.ts` — **modify**. Consume the contracts registry/result via ctx, with options/default fallback.
- `packages/tools/src/builtin/index.ts` — **modify**. Update exports.
- `packages/tools/src/__tests__/background-subagents.test.ts` → `packages/tools/src/__tests__/background-tasks.test.ts` — **rename + update** symbols/tool-names/shape.
- `packages/tools/src/__tests__/delegate.test.ts` — **modify** only if the async fold-back test references the old result shape (it does not — it asserts on the steered message text).

---

## Reference: current code (post Plan-1)

`packages/tools/src/builtin/background-subagents.ts` (177L): `BackgroundJobStatus`, `BackgroundJob { jobId, childName, capability, status, startedAt, settledAt?, runtime: AgentRuntime|null }`, `BackgroundJobSnapshot`, `class BackgroundJobRegistry` (`register({jobId,childName,capability,runtime,startedAt})`, `settle(jobId,status,settledAt)`, `cancel(jobId)` → `runtime.abort()`, `pruneSettled()`, `list()`, `get(jobId)`), `createCheckSubagentsTool`, `createCancelSubagentTool`, `SubagentControlToolOptions { registry }`.

`delegate.ts` consumes it: `import { BackgroundJobRegistry } from './background-subagents.js'`; `DelegateToolOptions.jobRegistry?: BackgroundJobRegistry` with default `new BackgroundJobRegistry()`; `startBackgroundSubagent` calls `jobRegistry.register({jobId, childName, capability, runtime, startedAt})` then `void pumpBackgroundChild(...)`; `pumpBackgroundChild` calls `jobRegistry.settle(jobId, ...)`, `jobRegistry.get(jobId)`, builds `BackgroundSubagentResult { jobId, childName, content, isError }`, folds via `steerSelf` / `deliverResult`; `formatChildResult` uses `result.childName`.

`execution-harness.ts:157-176` injects `steerSelf` into ToolContext and builds `services` with `drainSteers`/`onSuspend`.

---

### Task 1: contracts — generic types, registry impl, ToolContext fields

**Files:**
- Create: `packages/contracts/src/background-task.ts`
- Modify: `packages/contracts/src/tool.ts` (add two `ToolContext` fields)
- Modify: `packages/contracts/src/index.ts` (export new module)
- Test: `packages/contracts/src/__tests__/background-task.test.ts`

**Interfaces:**
- Produces: `type BackgroundTaskStatus = 'running'|'done'|'error'|'cancelled'`
- Produces: `interface BackgroundTask { taskId: string; kind: string; label: string; status: BackgroundTaskStatus; startedAt: number; settledAt?: number; abort: (() => void) | null }`
- Produces: `interface BackgroundTaskSnapshot { taskId: string; kind: string; label: string; status: BackgroundTaskStatus; startedAt: number; settledAt?: number }`
- Produces: `interface BackgroundTaskResult { taskId: string; kind: string; label: string; content: string; isError: boolean }`
- Produces: `interface BackgroundTaskRegistry { register(task: { taskId: string; kind: string; label: string; startedAt: number; abort: () => void }): void; settle(taskId: string, status: Exclude<BackgroundTaskStatus,'running'>, settledAt: number): void; cancel(taskId: string): boolean; list(): BackgroundTaskSnapshot[]; get(taskId: string): BackgroundTask | null }`
- Produces: `class InMemoryBackgroundTaskRegistry implements BackgroundTaskRegistry` (constructor `(maxSettledRetained = 50)`)
- Produces: `ToolContext.backgroundTasks?: BackgroundTaskRegistry`, `ToolContext.deliverResult?: (result: BackgroundTaskResult) => void | Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/__tests__/background-task.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryBackgroundTaskRegistry } from '../background-task.js';

function reg(max?: number) {
  return new InMemoryBackgroundTaskRegistry(max);
}

describe('InMemoryBackgroundTaskRegistry', () => {
  it('registers a running task and lists a snapshot without the abort handle', () => {
    const r = reg();
    let aborted = false;
    r.register({ taskId: 't1', kind: 'subagent', label: 'coder', startedAt: 1, abort: () => { aborted = true; } });
    const list = r.list();
    expect(list).toEqual([{ taskId: 't1', kind: 'subagent', label: 'coder', status: 'running', startedAt: 1 }]);
    expect('abort' in (list[0] as object)).toBe(false);
    expect(aborted).toBe(false);
  });

  it('settle moves a running task to a terminal status and clears abort', () => {
    const r = reg();
    r.register({ taskId: 't1', kind: 'subagent', label: 'a', startedAt: 1, abort: () => {} });
    r.settle('t1', 'done', 5);
    const t = r.get('t1');
    expect(t?.status).toBe('done');
    expect(t?.settledAt).toBe(5);
    expect(t?.abort).toBeNull();
  });

  it('settle is a no-op for an unknown or already-settled task', () => {
    const r = reg();
    r.register({ taskId: 't1', kind: 'k', label: 'a', startedAt: 1, abort: () => {} });
    r.settle('t1', 'done', 5);
    r.settle('t1', 'error', 9); // ignored — already settled
    expect(r.get('t1')?.status).toBe('done');
    r.settle('nope', 'done', 1); // unknown — no throw
  });

  it('cancel aborts a running task, marks cancelled, and returns true', () => {
    const r = reg();
    let aborted = false;
    r.register({ taskId: 't1', kind: 'k', label: 'a', startedAt: 1, abort: () => { aborted = true; } });
    expect(r.cancel('t1')).toBe(true);
    expect(aborted).toBe(true);
    expect(r.get('t1')?.status).toBe('cancelled');
  });

  it('cancel returns false for unknown or already-settled tasks', () => {
    const r = reg();
    r.register({ taskId: 't1', kind: 'k', label: 'a', startedAt: 1, abort: () => {} });
    r.settle('t1', 'done', 2);
    expect(r.cancel('t1')).toBe(false);
    expect(r.cancel('missing')).toBe(false);
  });

  it('evicts oldest settled tasks beyond the retention cap; keeps running', () => {
    const r = reg(1);
    r.register({ taskId: 'run', kind: 'k', label: 'r', startedAt: 1, abort: () => {} });
    r.register({ taskId: 's1', kind: 'k', label: 's1', startedAt: 2, abort: () => {} });
    r.register({ taskId: 's2', kind: 'k', label: 's2', startedAt: 3, abort: () => {} });
    r.settle('s1', 'done', 10);
    r.settle('s2', 'done', 11);
    const ids = r.list().map((t) => t.taskId).sort();
    expect(ids).toContain('run');   // running never evicted
    expect(ids).toContain('s2');    // newest settled kept
    expect(ids).not.toContain('s1'); // oldest settled evicted
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/contracts && pnpm vitest run src/__tests__/background-task.test.ts`
Expected: FAIL — cannot resolve `../background-task.js`.

- [ ] **Step 3: Create the implementation**

Create `packages/contracts/src/background-task.ts`:

```ts
/**
 * Tool-neutral background-task layer.
 *
 * Any tool that launches detached work registers it in a BackgroundTaskRegistry
 * shared with the parent runtime, so the parent can observe it (check_tasks) and
 * cancel it (cancel_task). The launching tool decides delivery: fold into the
 * live turn via ctx.steerSelf, or — once the turn ends — via ctx.deliverResult.
 *
 * `kind` names the launching tool family (e.g. 'subagent'); `label` is a
 * human-readable name shown in check_tasks. Nothing here is subagent-specific.
 */

export type BackgroundTaskStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface BackgroundTask {
  taskId: string;
  kind: string;
  label: string;
  status: BackgroundTaskStatus;
  startedAt: number;
  settledAt?: number;
  /** Live cancellation handle — present only while running, cleared on settle. */
  abort: (() => void) | null;
}

export interface BackgroundTaskSnapshot {
  taskId: string;
  kind: string;
  label: string;
  status: BackgroundTaskStatus;
  startedAt: number;
  settledAt?: number;
}

/** Settled result delivered after the parent turn ended (deliverResult sink). */
export interface BackgroundTaskResult {
  taskId: string;
  kind: string;
  label: string;
  content: string;
  isError: boolean;
}

/**
 * Per-parent-runtime registry of background tasks. Shared between the launching
 * tool(s) and the check_tasks / cancel_task control tools.
 */
export interface BackgroundTaskRegistry {
  register(task: { taskId: string; kind: string; label: string; startedAt: number; abort: () => void }): void;
  settle(taskId: string, status: Exclude<BackgroundTaskStatus, 'running'>, settledAt: number): void;
  cancel(taskId: string): boolean;
  list(): BackgroundTaskSnapshot[];
  get(taskId: string): BackgroundTask | null;
}

/**
 * In-memory BackgroundTaskRegistry. One instance per parent agent runtime.
 *
 * @param maxSettledRetained Cap on retained settled (done/error/cancelled) tasks.
 *   Once exceeded, the oldest-settled are evicted so the map and check_tasks
 *   output don't grow without bound. Running tasks are never evicted. Default 50.
 */
export class InMemoryBackgroundTaskRegistry implements BackgroundTaskRegistry {
  private readonly tasks = new Map<string, BackgroundTask>();

  constructor(private readonly maxSettledRetained = 50) {}

  register(task: { taskId: string; kind: string; label: string; startedAt: number; abort: () => void }): void {
    this.tasks.set(task.taskId, {
      taskId: task.taskId,
      kind: task.kind,
      label: task.label,
      status: 'running',
      startedAt: task.startedAt,
      abort: task.abort,
    });
  }

  settle(taskId: string, status: Exclude<BackgroundTaskStatus, 'running'>, settledAt: number): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return;
    task.status = status;
    task.settledAt = settledAt;
    task.abort = null;
    this.pruneSettled();
  }

  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running' || !task.abort) return false;
    const abort = task.abort;
    task.status = 'cancelled';
    task.settledAt = Date.now();
    task.abort = null;
    abort();
    this.pruneSettled();
    return true;
  }

  private pruneSettled(): void {
    const settled = Array.from(this.tasks.values())
      .filter((t) => t.status !== 'running')
      .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
    for (let i = 0; i < settled.length - this.maxSettledRetained; i++) {
      this.tasks.delete(settled[i]!.taskId);
    }
  }

  list(): BackgroundTaskSnapshot[] {
    return Array.from(this.tasks.values())
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(({ abort: _abort, ...snap }) => snap);
  }

  get(taskId: string): BackgroundTask | null {
    return this.tasks.get(taskId) ?? null;
  }
}
```

- [ ] **Step 4: Add the ToolContext fields**

In `packages/contracts/src/tool.ts`, add an import at the top of the type imports and two fields to `ToolContext` (right after `steerSelf`, before the closing `}` at line ~103):

At the top of the file, add:
```ts
import type { BackgroundTaskRegistry, BackgroundTaskResult } from './background-task.js';
```

Inside `ToolContext`, after the `steerSelf?: ...` field:
```ts
  /**
   * Shared per-runtime background-task registry. Any tool that launches detached
   * work registers it here so the parent can observe/cancel it via check_tasks /
   * cancel_task. Undefined when the runtime doesn't support background tasks.
   */
  backgroundTasks?: BackgroundTaskRegistry;

  /**
   * Post-turn result sink. When a background task settles after the parent turn
   * has ended (steerSelf returned false / is absent), the result is delivered
   * here. The app wires this to start a new turn carrying the result. Undefined
   * → the result is logged and dropped.
   */
  deliverResult?: (result: BackgroundTaskResult) => void | Promise<void>;
```

- [ ] **Step 5: Export from contracts index**

In `packages/contracts/src/index.ts`, after the `export { textResult, errorResult, suspendResult } from './tool.js';` line (line ~144), add:

```ts
export type {
  BackgroundTaskStatus,
  BackgroundTask,
  BackgroundTaskSnapshot,
  BackgroundTaskResult,
  BackgroundTaskRegistry,
} from './background-task.js';
export { InMemoryBackgroundTaskRegistry } from './background-task.js';
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd packages/contracts && pnpm vitest run src/__tests__/background-task.test.ts && pnpm build`
Expected: 6 tests PASS; `tsc` succeeds.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/background-task.ts packages/contracts/src/tool.ts packages/contracts/src/index.ts packages/contracts/src/__tests__/background-task.test.ts
git commit -m "feat(contracts): tool-neutral background-task types + in-memory registry"
```

---

### Task 2: core — wire registry + deliverResult into the harness ToolContext

**Files:**
- Modify: `packages/core/src/execution-harness.ts` (options + injection at the steerSelf site)
- Test: `packages/core/src/__tests__/execution-harness.background-tasks.test.ts`

**Interfaces:**
- Consumes: `BackgroundTaskRegistry`, `BackgroundTaskResult`, `InMemoryBackgroundTaskRegistry` from `@dongkseo/contracts` (Task 1).
- Produces: `LocalExecutionHarnessOptions.backgroundTasks?: BackgroundTaskRegistry`, `LocalExecutionHarnessOptions.deliverResult?: (r: BackgroundTaskResult) => void | Promise<void>`. The harness injects `ctx.backgroundTasks` + `ctx.deliverResult` into every tool call's ToolContext.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/execution-harness.background-tasks.test.ts`:

```ts
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
function probeArchitecture(captured: { ctx?: ToolContext }): AgentArchitecture {
  return {
    name: 'probe',
    async *loop(services: RuntimeServices, _input: AgentInput): AsyncGenerator<AgentEvent> {
      await services.tools.execute('probe', 'c1', {}, services.signal);
      yield { type: 'done', content: 'ok', toolCalls: [] };
    },
  } as unknown as AgentArchitecture;
}

const nullLLM = { complete: async () => ({ content: '', toolCalls: [] }) } as unknown as LLMProvider;

describe('LocalExecutionHarness background-task wiring', () => {
  it('injects backgroundTasks and deliverResult into the tool ToolContext', async () => {
    const captured: { ctx?: ToolContext } = {};
    const registry = new InMemoryBackgroundTaskRegistry();
    const delivered: unknown[] = [];

    const tools = new CoreToolExecutor({
      tools: [{
        name: 'probe',
        description: 'probe',
        parameters: { type: 'object', properties: {} },
        execute: async (_id, _input, ctx) => { captured.ctx = ctx; return { type: 'text', text: 'x' }; },
      }],
      context: baseCtx,
    });

    const harness = new LocalExecutionHarness({
      architecture: probeArchitecture(captured),
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
    const tools = new CoreToolExecutor({
      tools: [{
        name: 'probe', description: 'probe',
        parameters: { type: 'object', properties: {} },
        execute: async (_id, _input, ctx) => { captured.ctx = ctx; return { type: 'text', text: 'x' }; },
      }],
      context: baseCtx,
    });
    const harness = new LocalExecutionHarness({ architecture: probeArchitecture(captured), llm: nullLLM, tools });
    for await (const _ev of harness.execute({ prompt: 'go' })) { /* drain */ }
    expect(captured.ctx?.backgroundTasks).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run src/__tests__/execution-harness.background-tasks.test.ts`
Expected: FAIL — `captured.ctx?.backgroundTasks` is `undefined` (not yet injected).

- [ ] **Step 3: Add options + fields**

In `packages/core/src/execution-harness.ts`:

Add to the contracts import (the `import type { ... } from '@dongkseo/contracts'` block near the top) the types `BackgroundTaskRegistry` and `BackgroundTaskResult`, and add a value import for the default impl:
```ts
import { InMemoryBackgroundTaskRegistry } from '@dongkseo/contracts';
```

In `LocalExecutionHarnessOptions`, after `conversationId?: string;` (line ~58), add:
```ts
  /** Shared background-task registry injected into every tool ToolContext. Defaults to a per-harness InMemoryBackgroundTaskRegistry. */
  backgroundTasks?: BackgroundTaskRegistry;
  /** Post-turn result sink for background tasks, forwarded to ToolContext.deliverResult. */
  deliverResult?: (result: BackgroundTaskResult) => void | Promise<void>;
```

In the class fields (after `private readonly conversationId?: string;`, line ~81), add:
```ts
  private readonly backgroundTasks: BackgroundTaskRegistry;
  private readonly deliverResult?: (result: BackgroundTaskResult) => void | Promise<void>;
```

In the constructor (after `this.conversationId = options.conversationId;`, line ~109), add:
```ts
    this.backgroundTasks = options.backgroundTasks ?? new InMemoryBackgroundTaskRegistry();
    this.deliverResult = options.deliverResult;
```

- [ ] **Step 4: Inject into ToolContext**

In `execute()`, modify the `withContext` call (lines ~158-162) to add the two fields next to `steerSelf`:
```ts
      if (baseToolContext && this.tools.withContext) {
        toolExecutor = this.tools.withContext({
          ...baseToolContext,
          ...(workspace ? { workdir: workspace.root, workspace } : {}),
          steerSelf: (message: string) => this.steer(message),
          backgroundTasks: this.backgroundTasks,
          deliverResult: this.deliverResult,
        });
      }
```

- [ ] **Step 5: Run test + typecheck**

Run: `cd packages/core && pnpm vitest run src/__tests__/execution-harness.background-tasks.test.ts && pnpm build`
Expected: 2 tests PASS; `tsc` succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/execution-harness.ts packages/core/src/__tests__/execution-harness.background-tasks.test.ts
git commit -m "feat(core): inject backgroundTasks registry + deliverResult into ToolContext"
```

---

### Task 3: tools — relocate/rename control tools, migrate delegate to the contracts registry

This is the atomic breaking change (file rename + symbol rename + delegate retype). Do it in one commit so the build stays green.

**Files:**
- Rename + rewrite: `packages/tools/src/builtin/background-subagents.ts` → `packages/tools/src/builtin/background-tasks.ts`
- Modify: `packages/tools/src/builtin/delegate.ts`
- Modify: `packages/tools/src/builtin/index.ts`
- Rename + update: `packages/tools/src/__tests__/background-subagents.test.ts` → `packages/tools/src/__tests__/background-tasks.test.ts`

**Interfaces:**
- Consumes: `BackgroundTaskRegistry`, `BackgroundTaskResult`, `InMemoryBackgroundTaskRegistry` from `@dongkseo/contracts`.
- Produces: `createCheckTasksTool(options: TaskControlToolOptions): ToolDefinition` (tool name `check_tasks`), `createCancelTasksTool(options: TaskControlToolOptions): ToolDefinition` (tool name `cancel_task`), `interface TaskControlToolOptions { registry: BackgroundTaskRegistry }`.
- Produces (delegate, unchanged externally): `DelegateToolOptions.jobRegistry?: BackgroundTaskRegistry`, `BackgroundSubagentResult = BackgroundTaskResult` (type alias).

- [ ] **Step 1: Update the test file (rename + new symbols) — failing**

Rename the test file and update it:
```bash
git mv packages/tools/src/__tests__/background-subagents.test.ts packages/tools/src/__tests__/background-tasks.test.ts
```

In `packages/tools/src/__tests__/background-tasks.test.ts`, change the import (lines 3-7) to:
```ts
import {
  createCheckTasksTool,
  createCancelTasksTool,
} from '../builtin/background-tasks.js';
import { InMemoryBackgroundTaskRegistry } from '@dongkseo/contracts';
```

Then apply these replacements throughout the file:
- `new BackgroundJobRegistry(` → `new InMemoryBackgroundTaskRegistry(`
- `createCancelSubagentTool({ registry: jobRegistry })` → `createCancelTasksTool({ registry: jobRegistry })`
- `createCheckSubagentsTool({ registry: jobRegistry })` → `createCheckTasksTool({ registry: jobRegistry })`
- The `deliverResult` mock signature `(r: { jobId: string; childName: string; content: string; isError: boolean })` → `(r: { taskId: string; kind: string; label: string; content: string; isError: boolean })`
- Any assertion reading `.childName` on a delivered result → `.label`; `.jobId` on a delivered result → `.taskId`
- The `cancel_subagent` / `check_subagents` references in test descriptions and any `.execute` calls that pass `{ job_id }` stay as `{ job_id }` (the cancel tool's param is still `job_id`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tools && pnpm vitest run src/__tests__/background-tasks.test.ts`
Expected: FAIL — `background-tasks.js` / `createCheckTasksTool` don't exist yet.

- [ ] **Step 3: Create `background-tasks.ts` (control tools only)**

```bash
git mv packages/tools/src/builtin/background-subagents.ts packages/tools/src/builtin/background-tasks.ts
```

Replace the ENTIRE contents of `packages/tools/src/builtin/background-tasks.ts` with:

```ts
/**
 * Background-task control tools.
 *
 * Tool-neutral: any tool may launch a background task and register it in the
 * shared BackgroundTaskRegistry (on ToolContext). These tools let the parent
 * agent observe (`check_tasks`) and cancel (`cancel_task`) those tasks. The
 * registry type + in-memory impl live in @dongkseo/contracts.
 */

import type { BackgroundTaskRegistry, ToolContext, ToolDefinition, ToolResult } from '@dongkseo/contracts';
import { textResult, errorResult } from '@dongkseo/contracts';

export interface TaskControlToolOptions {
  registry: BackgroundTaskRegistry;
}

/**
 * `check_tasks` — list the background tasks this agent launched, with their
 * status. Lets the agent decide whether to wait, proceed, or cancel.
 */
export function createCheckTasksTool(options: TaskControlToolOptions): ToolDefinition {
  return {
    name: 'check_tasks',
    description:
      'List background tasks you launched and their status ' +
      '(running / done / error / cancelled).',
    parameters: { type: 'object', properties: {} } as unknown as Record<string, unknown>,
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    async execute(_callId: string, _rawInput: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const tasks = options.registry.list();
      if (tasks.length === 0) return textResult('No background tasks.');
      return textResult(JSON.stringify(tasks));
    },
  };
}

/**
 * `cancel_task` — abort a running background task by id. The parent holds this
 * leash; cancelling invokes the task's registered abort handle.
 */
export function createCancelTasksTool(options: TaskControlToolOptions): ToolDefinition {
  return {
    name: 'cancel_task',
    description: 'Abort a running background task by its id (from check_tasks).',
    parameters: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string', description: 'Task id returned when the task was launched.' },
      },
    } as unknown as Record<string, unknown>,
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: true,
    async execute(_callId: string, rawInput: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const taskId = (rawInput as { task_id?: unknown })?.task_id;
      if (typeof taskId !== 'string' || !taskId.trim()) {
        return errorResult('task_id is required');
      }
      const ok = options.registry.cancel(taskId.trim());
      return ok
        ? textResult(`Cancelled task ${taskId.trim()}.`)
        : errorResult(`No running task with id ${taskId.trim()}.`);
    },
  };
}
```

> Note: the `cancel_task` param is renamed `job_id`→`task_id`. Update the test's `cancel` invocations to pass `{ task_id: jobId }` accordingly (adjust Step 1's note if the test passed `{ job_id }`).

- [ ] **Step 4: Migrate `delegate.ts` to the contracts registry**

In `delegate.ts`:

Replace the import line `import { BackgroundJobRegistry } from './background-subagents.js';` with:
```ts
import { InMemoryBackgroundTaskRegistry } from '@dongkseo/contracts';
import type { BackgroundTaskRegistry, BackgroundTaskResult } from '@dongkseo/contracts';
```

Change `BackgroundSubagentResult` (lines ~93-99) from an interface to an alias, immediately above `DelegateToolOptions`:
```ts
/** @deprecated Use BackgroundTaskResult. Kept for delegate's export surface. */
export type BackgroundSubagentResult = BackgroundTaskResult;
```

In `DelegateToolOptions`, change `jobRegistry?: BackgroundJobRegistry;` to `jobRegistry?: BackgroundTaskRegistry;` and `deliverResult?: (result: BackgroundSubagentResult) => void | Promise<void>;` stays (alias resolves to BackgroundTaskResult).

In `createDelegateTool`, change the default `jobRegistry = new BackgroundJobRegistry()` to `jobRegistry = new InMemoryBackgroundTaskRegistry()`.

In `startBackgroundSubagent`, prefer the ctx-provided registry/sink. After resolving `childRuntime`/`childName` and before registering, compute:
```ts
      const registry = ctx.backgroundTasks ?? jobRegistry;
      const sink = ctx.deliverResult ?? deliverResult;
```
Replace the `jobRegistry.register({ jobId, childName, capability: params.capability, runtime: childRuntime, startedAt: Date.now() })` call with:
```ts
      const jobId = messageId();
      registry.register({
        taskId: jobId,
        kind: 'subagent',
        label: childName,
        startedAt: Date.now(),
        abort: () => childRuntime.abort(),
      });
```
And update the `void pumpBackgroundChild({ ... })` call to pass `jobRegistry: registry` and `deliverResult: sink` (instead of the closure-captured `jobRegistry`/`deliverResult`). Keep `steerSelf: ctx.steerSelf`.

Update `pumpBackgroundChild`:
- Its `jobRegistry` param type → `BackgroundTaskRegistry`; `deliverResult` param type → `(result: BackgroundTaskResult) => void | Promise<void>`.
- Replace `jobRegistry.settle(jobId, isError ? 'error' : 'done', Date.now())` (uses `jobId`/`childName` locals — keep the local names) — the call already uses `jobId`; it maps to `taskId`. Keep as `jobRegistry.settle(jobId, ...)`.
- Replace the result construction:
```ts
  const result: BackgroundTaskResult = { taskId: jobId, kind: 'subagent', label: childName, content: content || '(no output)', isError };
```

Update `formatChildResult` to read `result.label` instead of `result.childName`:
```ts
function formatChildResult(result: BackgroundTaskResult): string {
  const status = result.isError ? 'failed' : 'completed';
  return `[background subagent "${result.label}" ${status}] (job ${result.taskId})\n${result.content}`;
}
```

- [ ] **Step 5: Update `builtin/index.ts` exports**

Replace the background block (lines ~50-60):
```ts
export {
  createCheckTasksTool,
  createCancelTasksTool,
} from './background-tasks.js';
export type { TaskControlToolOptions } from './background-tasks.js';
```
(The registry type/impl and `BackgroundTask*` types are exported from `@dongkseo/contracts`, not here. `BackgroundSubagentResult` remains exported from `./delegate.js` via the existing delegate export block.)

- [ ] **Step 6: Run the tools suite + whole-repo typecheck**

Run: `cd packages/tools && pnpm vitest run src/__tests__/background-tasks.test.ts src/__tests__/delegate.test.ts`
Expected: PASS (control-tool tests + delegate tests).

Run: `cd /Users/dongkseo/Project/Nexora && pnpm build`
Expected: all packages `tsc` clean — confirms no dangling `BackgroundJobRegistry`/`createCheckSubagentsTool`/`background-subagents.js` references anywhere.

- [ ] **Step 7: Run the whole repo test suite**

Run: `cd /Users/dongkseo/Project/Nexora && pnpm test`
Expected: all turbo test tasks PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(tools): tool-neutral background-task layer; delegate consumes contracts registry"
```

---

## Self-Review

**1. Spec coverage:**
- §1 contracts types + impl + ToolContext fields → Task 1. ✓
- §2 registry impl in contracts, control tools in tools (renamed) → Task 1 (impl) + Task 3 (tools). ✓
- §3 delegate as consumer (kind/label, ctx-sourced registry/sink, BackgroundSubagentResult alias, behavior unchanged) → Task 3 Step 4. ✓
- §4 harness wiring via onSuspend pattern → Task 2. ✓
- §5 exports + test renames → Task 3 Steps 1,5; contracts/core tests in Tasks 1,2. ✓
- Scope boundary (no new-turn starter, no other-tool adoption) → respected; `deliverResult` stays an injected sink. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases". All code shown in full. The Step 1↔Step 3 note about `job_id`→`task_id` is an explicit cross-reference, not a placeholder.

**3. Type consistency:** `BackgroundTaskRegistry` interface (Task 1) is the type used in Task 2 options, Task 3 control tools + delegate. `register({taskId,kind,label,startedAt,abort})` matches across Task 1 impl, Task 1 test, and Task 3 delegate call. `BackgroundTaskResult {taskId,kind,label,content,isError}` consistent across Task 1, delegate result construction, `formatChildResult`, and the Task 3 test's deliverResult mock. `InMemoryBackgroundTaskRegistry` constructor `(maxSettledRetained=50)` consistent. Tool names `check_tasks`/`cancel_task` and param `task_id` consistent between the impl (Task 3 Step 3) and the test (Task 3 Step 1 note). ✓

---

## Out of Scope (follow-up)

- App-level `deliverResult` wiring (adapter starts a new turn carrying the result) — discord/gateway adapters.
- Migrating non-delegate tools to launch background tasks — incremental, when a real need appears.
