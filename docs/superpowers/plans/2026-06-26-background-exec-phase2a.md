# Monitoring Triggers — Phase 2a (background-exec) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let the agent run a shell command in the background: `exec({ run_in_background: true })` spawns detached, registers a `kind:'bash'` task in the wired `ctx.backgroundTasks` registry (so `check_tasks`/`cancel_task`/`watch_task` apply for free), streams stdout/stderr into an in-memory tail buffer, and exposes it via a new `read_task_output` tool.

**Architecture:** Self-contained in the already-wired background-task layer — NO AuditStore/store wiring (which doesn't reach tools yet). `BackgroundTask` gains an optional `readOutput?: () => string`; background-exec registers with it and a `kill()` abort; `read_task_output` reads it. Durable audit is a later follow-up.

**Tech Stack:** TypeScript (ESM `.js`), Vitest (real subprocesses: `echo`/`sleep`), pnpm + turbo.

## Global Constraints

- ESM `.js` specifiers; no new deps.
- Background process must NOT be tied to `ctx.signal` (the turn's abort) — it survives the turn; it's stopped only via `cancel_task` (`child.kill()`) or its own exit. (Same survival rule as background subagents.)
- Output buffer keeps the **tail** (last `MAX_OUTPUT_BYTES = 256*1024`) so long-running monitors show recent output.
- `run_in_background` requires `ctx.backgroundTasks`; absent → error.
- Preserve all existing exec validation (allowList, interpreter block, program validation) — the background branch sits AFTER validation/resolution.
- Background uses the direct `spawn` path (not the workspace/sandbox path) in 2a.
- Build green at every commit: contracts (Task 1) → tools (Task 2).

---

## File Structure

- `packages/contracts/src/background-task.ts` — **modify**. Add `readOutput?: () => string` to `BackgroundTask` + `register` spec + impl.
- `packages/contracts/src/__tests__/background-task.test.ts` — **modify**. Cover `readOutput`.
- `packages/tools/src/builtin/exec.ts` — **modify**. `run_in_background` param + background branch.
- `packages/tools/src/builtin/background-tasks.ts` — **modify**. Add `createReadTaskOutputTool`.
- `packages/tools/src/builtin/index.ts` — **modify**. Export it.
- `packages/tools/src/__tests__/exec-background.test.ts` — **new**. Real-subprocess background tests.

---

### Task 1: contracts — `BackgroundTask.readOutput`

**Files:**
- Modify: `packages/contracts/src/background-task.ts`
- Test: `packages/contracts/src/__tests__/background-task.test.ts`

**Interfaces:**
- Produces: `BackgroundTask.readOutput?: () => string`; `register(task: { ...; readOutput?: () => string })` accepts and stores it; `get()` returns it; `list()` snapshot excludes it (unchanged).

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/__tests__/background-task.test.ts` (inside the `InMemoryBackgroundTaskRegistry` describe):

```ts
  it('stores and exposes a readOutput handle via get(), absent from list snapshot', () => {
    const r = reg();
    let buf = 'hello';
    r.register({ taskId: 't1', kind: 'bash', label: 'echo', startedAt: 1, abort: () => {}, readOutput: () => buf });
    expect(r.get('t1')?.readOutput?.()).toBe('hello');
    buf = 'hello world';
    expect(r.get('t1')?.readOutput?.()).toBe('hello world'); // live handle
    expect('readOutput' in (r.list()[0] as object)).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/contracts && pnpm vitest run src/__tests__/background-task.test.ts -t readOutput`
Expected: FAIL — `register` rejects `readOutput` / `get().readOutput` undefined.

- [ ] **Step 3: Implement**

In `packages/contracts/src/background-task.ts`:

Add to the `BackgroundTask` interface (after `abort: (() => void) | null;`):
```ts
  /** Live handle to the task's captured output (e.g. background shell stdout).
   *  Present only for tasks that stream output. Cleared on settle. */
  readOutput?: () => string;
```

Update the `register` signature in the `BackgroundTaskRegistry` interface AND the impl to accept `readOutput`:
```ts
  register(task: { taskId: string; kind: string; label: string; startedAt: number; abort: () => void; readOutput?: () => string }): void;
```

In `InMemoryBackgroundTaskRegistry.register`, store it:
```ts
  register(task: { taskId: string; kind: string; label: string; startedAt: number; abort: () => void; readOutput?: () => string }): void {
    this.tasks.set(task.taskId, {
      taskId: task.taskId,
      kind: task.kind,
      label: task.label,
      status: 'running',
      startedAt: task.startedAt,
      abort: task.abort,
      readOutput: task.readOutput,
    });
  }
```

(`list()` already destructures `{ abort: _abort, ...snap }` — also drop `readOutput` from the snapshot: change to `({ abort: _abort, readOutput: _readOutput, ...snap })`.)

- [ ] **Step 4: Run tests + typecheck**

Run: `cd packages/contracts && pnpm vitest run src/__tests__/background-task.test.ts && pnpm build`
Expected: all PASS; `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/background-task.ts packages/contracts/src/__tests__/background-task.test.ts
git commit -m "feat(contracts): BackgroundTask.readOutput handle for streamed output"
```

---

### Task 2: tools — `exec run_in_background` + `read_task_output`

**Files:**
- Modify: `packages/tools/src/builtin/exec.ts`
- Modify: `packages/tools/src/builtin/background-tasks.ts`, `packages/tools/src/builtin/index.ts`
- Test: `packages/tools/src/__tests__/exec-background.test.ts`

**Interfaces:**
- Consumes: `ctx.backgroundTasks` (with `readOutput` from Task 1), `messageId` from contracts.
- Produces: `exec` accepts `run_in_background: boolean`; `createReadTaskOutputTool(): ToolDefinition` (name `read_task_output`, param `task_id`).

- [ ] **Step 1: Write the failing test**

Create `packages/tools/src/__tests__/exec-background.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createExecTool } from '../builtin/exec.js';
import { createReadTaskOutputTool } from '../builtin/background-tasks.js';
import { InMemoryBackgroundTaskRegistry } from '@dongkseo/contracts';
import type { ToolContext } from '@dongkseo/contracts';

function ctx(reg: InMemoryBackgroundTaskRegistry): ToolContext {
  return {
    tenantId: 't', workdir: process.cwd(),
    secrets: { get: async () => undefined },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    backgroundTasks: reg,
  } as ToolContext;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('exec run_in_background', () => {
  it('launches echo in background, settles done, and captures stdout', async () => {
    const reg = new InMemoryBackgroundTaskRegistry();
    const exec = createExecTool({ allowList: ['echo'] });
    const read = createReadTaskOutputTool();

    const res = await exec.execute('e1', { argv: ['echo', 'hello-bg'], run_in_background: true }, ctx(reg));
    expect(res.type).toBe('text');
    const id = reg.list()[0]!.taskId;

    await sleep(200); // let echo finish + close fire
    expect(reg.get(id)?.status).toBe('done');

    const out = await read.execute('r1', { task_id: id }, ctx(reg));
    expect(out.type).toBe('text');
    if (out.type === 'text') expect(out.text).toContain('hello-bg');
  });

  it('cancel_task kills a long-running background process', async () => {
    const reg = new InMemoryBackgroundTaskRegistry();
    const exec = createExecTool({ allowList: ['sleep'] });
    await exec.execute('e2', { argv: ['sleep', '30'], run_in_background: true }, ctx(reg));
    const id = reg.list()[0]!.taskId;
    expect(reg.get(id)?.status).toBe('running');
    expect(reg.cancel(id)).toBe(true);
    await sleep(100);
    expect(reg.get(id)?.status).toBe('cancelled');
  });

  it('errors when run_in_background without a registry', async () => {
    const exec = createExecTool({ allowList: ['echo'] });
    const res = await exec.execute('e3', { argv: ['echo', 'x'], run_in_background: true },
      { tenantId: 't', workdir: process.cwd(), secrets: { get: async () => undefined }, logger: { info() {}, warn() {}, error() {} } } as ToolContext);
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toMatch(/not supported|registry/i);
  });

  it('read_task_output errors on unknown id', async () => {
    const reg = new InMemoryBackgroundTaskRegistry();
    const read = createReadTaskOutputTool();
    const res = await read.execute('r2', { task_id: 'nope' }, ctx(reg));
    expect(res.type).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tools && pnpm vitest run src/__tests__/exec-background.test.ts`
Expected: FAIL — `run_in_background` ignored / `createReadTaskOutputTool` missing.

- [ ] **Step 3: Add `createReadTaskOutputTool` to `background-tasks.ts`**

Append to `packages/tools/src/builtin/background-tasks.ts`:

```ts
/**
 * `read_task_output` — read the captured stdout/stderr of a background task
 * (e.g. a background shell). Polls the task's live output buffer.
 */
export function createReadTaskOutputTool(): ToolDefinition {
  return {
    name: 'read_task_output',
    description: 'Read the captured output (stdout/stderr) of a background task by its id (from check_tasks).',
    parameters: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'string', description: 'Task id from check_tasks / a launched background task.' } },
    } as unknown as Record<string, unknown>,
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    async execute(_callId: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      const registry = ctx.backgroundTasks;
      if (!registry) return errorResult('Background tasks are not supported in this runtime.');
      const taskId = (rawInput as { task_id?: unknown }).task_id;
      if (typeof taskId !== 'string' || !taskId.trim()) return errorResult('task_id is required.');
      const task = registry.get(taskId.trim());
      if (!task) return errorResult(`No task with id ${taskId.trim()}.`);
      if (!task.readOutput) return errorResult(`Task ${taskId.trim()} has no captured output.`);
      const out = task.readOutput();
      return textResult(out.length > 0 ? out : '(no output yet)');
    },
  };
}
```

- [ ] **Step 4: Export it**

In `packages/tools/src/builtin/index.ts`, add `createReadTaskOutputTool` to the `./background-tasks.js` export block (alongside `createCheckTasksTool` etc.).

- [ ] **Step 5: Add `run_in_background` to exec**

In `packages/tools/src/builtin/exec.ts`:

Add `messageId` to the contracts value import:
```ts
import { textResult, errorResult, safeUtf8Prefix, safeUtf8Suffix, messageId } from '@dongkseo/contracts';
```

Add the param to the schema `properties` (after `timeoutMs`):
```ts
        run_in_background: { type: 'boolean', description: 'Run detached: returns a task id immediately; poll output with read_task_output, manage with check_tasks/cancel_task/watch_task.' },
```

Read it from params at the top of `execute` (extend the cast):
```ts
      const params = input as { argv?: unknown; command?: unknown; timeoutMs?: unknown; run_in_background?: unknown };
```

Insert the background branch immediately after `const workdir = ctx.workspace?.root ?? ctx.workdir;` (line ~252) and BEFORE `if (ctx.workspace?.run) {`:

```ts
      if (params.run_in_background === true) {
        const registry = ctx.backgroundTasks;
        if (!registry) {
          return errorResult('run_in_background needs a background-task registry (not supported in this runtime).');
        }
        const taskId = messageId();
        // Detached: not bound to ctx.signal — survives the turn; stopped via cancel_task.
        const child = spawn(program, args, { cwd: workdir, env, shell: false });
        let out = '';
        const onData = (chunk: Buffer): void => {
          out += chunk.toString('utf8');
          if (out.length > MAX_OUTPUT_BYTES) out = out.slice(out.length - MAX_OUTPUT_BYTES); // keep tail
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.on('error', (err) => {
          out += `\n[spawn error: ${err.message}]`;
          registry.settle(taskId, 'error', Date.now());
        });
        child.on('close', (code) => {
          registry.settle(taskId, code === 0 ? 'done' : 'error', Date.now());
        });
        registry.register({
          taskId,
          kind: 'bash',
          label,
          startedAt: Date.now(),
          abort: () => { child.kill(); },
          readOutput: () => out,
        });
        ctx.logger.info('exec.background.launched', { taskId, program, label });
        return textResult(
          `Launched background task ${taskId}: ${label}. ` +
          `Poll output with read_task_output (id "${taskId}"), status with check_tasks, ` +
          `stop with cancel_task, or get notified on completion with watch_task.`,
        );
      }
```

- [ ] **Step 6: Run background tests**

Run: `cd packages/tools && pnpm vitest run src/__tests__/exec-background.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 7: Whole-repo build + suite**

Run: `cd /Users/dongkseo/Project/Nexora && pnpm build && pnpm test`
Expected: all `tsc` clean; all turbo test tasks PASS (existing exec/background-tasks tests unaffected — `run_in_background` is opt-in).

- [ ] **Step 8: Commit**

```bash
git add packages/tools/src/builtin/exec.ts packages/tools/src/builtin/background-tasks.ts packages/tools/src/builtin/index.ts packages/tools/src/__tests__/exec-background.test.ts
git commit -m "feat(tools): exec run_in_background + read_task_output — background shell on the task layer"
```

---

## Self-Review

**1. Coverage:** background spawn + register `kind:'bash'` + tail buffer + settle on exit → Task 2 branch. Output access → `read_task_output` (Task 2) + `readOutput` handle (Task 1). Cancel via `child.kill()` → `abort` (test 2). Survives turn (not bound to ctx.signal) → branch uses bare `spawn`. Reuses check_tasks/cancel_task/watch_task → free (same registry). ✓ AuditStore durability → deferred (noted). ✓

**2. Placeholder scan:** No TBD/vague steps; full code shown. ✓

**3. Type consistency:** `readOutput?: () => string` identical across `BackgroundTask`, `register` spec/impl (Task 1), and the exec `register({...readOutput})` call + `read_task_output` reader (Task 2). `run_in_background` param + `messageId` import consistent. ✓

---

## Next cycle (not this plan)

- **Phase 2b** — audit-stream regex trigger: once an AuditStore→tool seam exists, mirror background output into `AuditStore.record` and add a `when(source:stream, regex)` trigger (poll `query(since)`).
- **App wiring** — `deliverResult` → new turn (adapter) for fully-idle self-wake.
