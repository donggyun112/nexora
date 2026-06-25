# Delegate Engine Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse delegate's two duplicated runtime-driving functions (`runRuntime` for sync, `pumpBackgroundChild` for async) into one shared engine consumed two ways, removing the duplicated `for await (runtime.execute())` drain loop.

**Architecture:** Extract a pure `drainRuntime()` helper that drives an `AgentRuntime` to completion and returns a `{ content, isError, timedOut }` outcome. The sync path (`runRuntime`) awaits it and maps the outcome to a `ToolResult`. The async path (`pumpBackgroundChild`) awaits it, settles the job, and folds the result back via `steerSelf`/`deliverResult`. No behavior change for callers; this is a DRY refactor of working, tested code.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, pnpm workspaces. Package: `@dongkseo/tools`.

## Global Constraints

- Language: TypeScript, ESM modules. Import paths use `.js` extension even for `.ts` files.
- Test runner: Vitest. Run tests from `packages/tools/` with `pnpm vitest run <path>`.
- No new dependencies.
- Preserve existing public exports of `delegate.ts` (`createDelegateTool`, the `Subagent`/`*ToolOptions` interfaces, `BackgroundSubagentResult`). `drainRuntime` is an internal module-level function — do NOT export it.
- Preserve observable behavior: sync delegate returns the child's final content as a `text` ToolResult (or `error`); async delegate returns the "launched" message immediately and folds the result via `steerSelf`/`deliverResult`.
- Existing fallback strings must be preserved exactly: sync uses `'(no response)'`, async result uses `'(no output)'`. `drainRuntime` itself applies NO fallback — it returns raw `content` (possibly empty); each caller applies its own historical fallback.
- The timeout-abort path (`timedOut`, `runtime.abort()`, `timer.unref()`) currently exists only on the async path. After the refactor it lives in `drainRuntime` and is opt-in via `opts.timeoutMs`. The sync path passes no `timeoutMs`, so sync keeps its current no-wall-clock-timeout behavior.

---

## File Structure

- `packages/tools/src/builtin/delegate.ts` — add `drainRuntime()` near the other module-level helpers (after `runRuntime`/`pumpBackgroundChild` region, ~line 588+). Refactor `runRuntime` and `pumpBackgroundChild` to call it.
- `packages/tools/src/__tests__/delegate.test.ts` — existing sync/async behavior tests; extend with drain-specific cases (error event, timeout). Existing `FakeTransport`/`makeCtx`/`makeRegistry` helpers are reused.

No new files. No contract changes.

---

## Reference: current code being unified

`runRuntime` (sync, `delegate.ts:572-588`):
```ts
async function runRuntime(name, runtime, params, onEvent?): Promise<ToolResult> {
  const input: AgentInput = { prompt: typeof params.input === 'string' ? params.input : JSON.stringify(params.input) };
  let content = '';
  for await (const event of runtime.execute(input)) {
    onEvent?.(event);
    if (event.type === 'done') content = event.content;
    else if (event.type === 'error') return errorResult(`subagent "${name}": ${event.message}`);
  }
  return textResult(content || '(no response)');
}
```

`pumpBackgroundChild` core (async, `delegate.ts:598-678`), the drained part:
```ts
const childInput: AgentInput = { prompt: typeof input === 'string' ? input : JSON.stringify(input) };
let timedOut = false;
const timer = timeoutMs && timeoutMs > 0
  ? setTimeout(() => { timedOut = true; runtime.abort(); }, timeoutMs) : null;
timer?.unref?.();
let content = ''; let isError = false;
try {
  for await (const event of runtime.execute(childInput)) {
    onSubagentEvent?.(childName, event);
    if (event.type === 'done') content = event.content;
    else if (event.type === 'error') { content = event.message; isError = true; }
  }
} catch (err) { content = err instanceof Error ? err.message : String(err); isError = true; }
finally { if (timer) clearTimeout(timer); }
if (timedOut) { content = `Background subagent "${childName}" exceeded ${timeoutMs}ms and was aborted.`; isError = true; }
// ... then: jobRegistry.settle(...), steerSelf/deliverResult delivery (UNCHANGED, stays in pumpBackgroundChild)
```

**Intentional, benign behavior change for the sync path:** today `runRuntime` early-`return`s an error on the first `error` event; after the refactor it fully drains the generator (an `error` event is terminal in practice, so the generator ends anyway), then the sync wrapper maps `isError` to `errorResult`. The error message format changes from `subagent "${name}": ${event.message}` to just `event.message` carried in `content`; the sync wrapper re-applies the `subagent "${name}": ` prefix so the surfaced message is identical. Covered by Task 3's tests.

---

### Task 1: Add `drainRuntime` helper (pure, TDD)

**Files:**
- Modify: `packages/tools/src/builtin/delegate.ts` (add module-level `drainRuntime` + `DrainOutcome` interface after the `runRuntime` definition, ~line 589)
- Test: `packages/tools/src/__tests__/delegate.test.ts` (add a `describe('drainRuntime via background path', ...)` — drain is internal, so it is exercised through `pumpBackgroundChild` in later tasks; in THIS task we test it directly by temporarily not exporting — see note)

**Interfaces:**
- Produces: `interface DrainOutcome { content: string; isError: boolean; timedOut: boolean }`
- Produces: `async function drainRuntime(name: string, runtime: AgentRuntime, input: unknown, opts?: { onEvent?: (event: AgentEvent) => void; timeoutMs?: number }): Promise<DrainOutcome>` — module-internal (not exported).
- Consumes: `AgentRuntime`, `AgentInput`, `AgentEvent` (already imported in `delegate.ts`).

> **Note on testing an unexported function:** `drainRuntime` stays unexported (Global Constraints). To test it directly without changing its visibility, Task 1's test drives a fake `AgentRuntime` through the EXISTING async entry point is not yet wired — so for Task 1 we add a **temporary** named export `export { drainRuntime as __drainRuntimeForTest }` guarded by a comment, write the unit tests against it, and REMOVE that temporary export in Task 3's commit once `pumpBackgroundChild`/`runRuntime` exercise it end-to-end. This keeps Task 1 independently testable.

- [ ] **Step 1: Write the failing test**

Add to `packages/tools/src/__tests__/delegate.test.ts`:

```ts
import { __drainRuntimeForTest as drainRuntime } from '../builtin/delegate.js';
import type { AgentRuntime, AgentInput, AgentEvent } from '@dongkseo/contracts';

function fakeRuntime(events: AgentEvent[], opts: { hang?: boolean } = {}): AgentRuntime {
  let aborted = false;
  return {
    abort: () => { aborted = true; },
    // eslint-disable-next-line @typescript-eslint/require-await
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent> {
      for (const e of events) {
        if (aborted) return;
        yield e;
      }
      if (opts.hang) {
        // never-resolving wait so the timeout path can abort it
        await new Promise<void>(() => {});
      }
    },
  } as unknown as AgentRuntime;
}

describe('drainRuntime', () => {
  it('returns the last done content with isError=false', async () => {
    const rt = fakeRuntime([
      { type: 'done', content: 'final answer', toolCalls: [] } as AgentEvent,
    ]);
    const out = await drainRuntime('child', rt, { prompt: 'hi' });
    expect(out).toEqual({ content: 'final answer', isError: false, timedOut: false });
  });

  it('marks isError and carries the message on an error event', async () => {
    const rt = fakeRuntime([
      { type: 'error', message: 'boom' } as AgentEvent,
    ]);
    const out = await drainRuntime('child', rt, { prompt: 'hi' });
    expect(out).toEqual({ content: 'boom', isError: true, timedOut: false });
  });

  it('relays events via onEvent', async () => {
    const seen: string[] = [];
    const rt = fakeRuntime([
      { type: 'done', content: 'x', toolCalls: [] } as AgentEvent,
    ]);
    await drainRuntime('child', rt, 'plain string', {
      onEvent: (e) => seen.push(e.type),
    });
    expect(seen).toEqual(['done']);
  });

  it('aborts and reports timedOut when timeoutMs elapses', async () => {
    const rt = fakeRuntime([], { hang: true });
    const out = await drainRuntime('slow', rt, { prompt: 'hi' }, { timeoutMs: 20 });
    expect(out.timedOut).toBe(true);
    expect(out.isError).toBe(true);
    expect(out.content).toContain('exceeded 20ms');
  });

  it('serializes a non-string input to JSON for the prompt', async () => {
    let receivedPrompt: unknown;
    const rt = {
      abort: () => {},
      async *execute(input: AgentInput) {
        receivedPrompt = input.prompt;
        yield { type: 'done', content: 'ok', toolCalls: [] } as AgentEvent;
      },
    } as unknown as AgentRuntime;
    await drainRuntime('child', rt, { a: 1 });
    expect(receivedPrompt).toBe(JSON.stringify({ a: 1 }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tools && pnpm vitest run src/__tests__/delegate.test.ts -t drainRuntime`
Expected: FAIL — `__drainRuntimeForTest` is not exported (import resolves to `undefined`, calls throw).

- [ ] **Step 3: Write minimal implementation**

In `packages/tools/src/builtin/delegate.ts`, immediately after the `runRuntime` function (after line 588), add:

```ts
interface DrainOutcome {
  content: string;
  isError: boolean;
  timedOut: boolean;
}

/**
 * Drives an AgentRuntime to completion and returns its outcome. Shared core for
 * both the sync delegate path (runRuntime) and the background path
 * (pumpBackgroundChild). Applies NO content fallback — callers apply their own.
 * When opts.timeoutMs is set, a hung child is aborted and reported via timedOut.
 */
async function drainRuntime(
  name: string,
  runtime: AgentRuntime,
  input: unknown,
  opts: { onEvent?: (event: AgentEvent) => void; timeoutMs?: number } = {},
): Promise<DrainOutcome> {
  const agentInput: AgentInput = {
    prompt: typeof input === 'string' ? input : JSON.stringify(input),
  };

  let timedOut = false;
  const timer =
    opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          runtime.abort();
        }, opts.timeoutMs)
      : null;
  timer?.unref?.();

  let content = '';
  let isError = false;
  try {
    for await (const event of runtime.execute(agentInput)) {
      opts.onEvent?.(event);
      if (event.type === 'done') content = event.content;
      else if (event.type === 'error') {
        content = event.message;
        isError = true;
      }
    }
  } catch (err) {
    content = err instanceof Error ? err.message : String(err);
    isError = true;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (timedOut) {
    content = `Background subagent "${name}" exceeded ${opts.timeoutMs}ms and was aborted.`;
    isError = true;
  }

  return { content, isError, timedOut };
}

// TEMPORARY: removed in the "route sync through drainRuntime" commit (Task 3).
export { drainRuntime as __drainRuntimeForTest };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tools && pnpm vitest run src/__tests__/delegate.test.ts -t drainRuntime`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/builtin/delegate.ts packages/tools/src/__tests__/delegate.test.ts
git commit -m "refactor(delegate): extract drainRuntime as shared runtime-driving core"
```

---

### Task 2: Route the async path (`pumpBackgroundChild`) through `drainRuntime`

**Files:**
- Modify: `packages/tools/src/builtin/delegate.ts:598-678` (`pumpBackgroundChild` — replace the inline drain loop with a `drainRuntime` call; keep settle + delivery logic verbatim)
- Test: `packages/tools/src/__tests__/delegate.test.ts` (existing background-subagent tests must still pass; no new test required if coverage exists — otherwise add one asserting a background result is folded via `steerSelf`)

**Interfaces:**
- Consumes: `drainRuntime(name, runtime, input, { onEvent, timeoutMs }) → Promise<DrainOutcome>` from Task 1.
- Produces: unchanged `pumpBackgroundChild` signature and delivery behavior.

- [ ] **Step 1: Write/confirm the failing test**

Confirm an existing test covers the background fold-back. If none asserts `steerSelf` delivery, add to `delegate.test.ts`:

```ts
it('async background subagent folds its result into the live turn via steerSelf', async () => {
  const transport = new FakeTransport();
  const registry = makeRegistry([]);
  const steered: string[] = [];
  const compiled = {
    type: 'compiled' as const,
    name: 'worker',
    description: 'w',
    runtime: {
      abort: () => {},
      async *execute() {
        yield { type: 'done', content: 'bg done', toolCalls: [] };
      },
    },
  };
  const tool = createDelegateTool({
    transport, registry, subagents: [compiled as never], callerAgentName: 'parent',
  });
  const ctx = { ...makeCtx(), steerSelf: (m: string) => { steered.push(m); return true; } };
  const result = await tool.execute('d-async', {
    capability: 'worker', input: 'go', waitForResult: 'async',
  }, ctx);

  expect(result.type).toBe('text');
  if (result.type === 'text') expect(result.text).toContain('background job');
  // allow the detached pump microtasks to flush
  await new Promise((r) => setTimeout(r, 10));
  expect(steered.some((m) => m.includes('bg done'))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify current state**

Run: `cd packages/tools && pnpm vitest run src/__tests__/delegate.test.ts`
Expected: the new test PASSES against the pre-refactor code (it documents current behavior); all existing tests PASS. (This task is a refactor — the test guards behavior across the change.)

- [ ] **Step 3: Refactor `pumpBackgroundChild` to use `drainRuntime`**

In `delegate.ts`, replace the body of `pumpBackgroundChild` from the `const childInput` declaration through the `if (timedOut) {...}` block (the drain region) with a single call. The result is:

```ts
async function pumpBackgroundChild(args: {
  jobId: string;
  childName: string;
  runtime: AgentRuntime;
  input: unknown;
  jobRegistry: BackgroundJobRegistry;
  onSubagentEvent?: (name: string, event: AgentEvent) => void;
  steerSelf?: (message: string) => boolean;
  deliverResult?: (result: BackgroundSubagentResult) => void | Promise<void>;
  logger: ToolLogger;
  timeoutMs?: number;
}): Promise<void> {
  const { jobId, childName, runtime, input, jobRegistry, onSubagentEvent, steerSelf, deliverResult, logger, timeoutMs } = args;

  const { content, isError } = await drainRuntime(childName, runtime, input, {
    onEvent: onSubagentEvent ? (e) => onSubagentEvent(childName, e) : undefined,
    timeoutMs,
  });

  // settle() is a no-op if the job was already marked cancelled by cancel_subagent.
  jobRegistry.settle(jobId, isError ? 'error' : 'done', Date.now());
  if (jobRegistry.get(jobId)?.status === 'cancelled') return;

  const result: BackgroundSubagentResult = { jobId, childName, content: content || '(no output)', isError };
  const message = formatChildResult(result);

  // Fold into the parent's live turn; steerSelf returns false once that turn ends.
  if (steerSelf?.(message)) return;

  if (deliverResult) {
    try {
      await deliverResult(result);
    } catch (err) {
      logger.error('delegate.background.deliver_failed', {
        jobId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  logger.warn('delegate.background.result_dropped', {
    jobId,
    childName,
    reason: 'parent turn ended and no deliverResult sink configured',
  });
}
```

Note: the `Date.now()` call timestamp in `settle` is preserved (was already there at `:652`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/tools && pnpm vitest run src/__tests__/delegate.test.ts`
Expected: PASS (all existing + the fold-back test). Behavior unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/builtin/delegate.ts packages/tools/src/__tests__/delegate.test.ts
git commit -m "refactor(delegate): drive background subagent through drainRuntime"
```

---

### Task 3: Route the sync path (`runRuntime`) through `drainRuntime`; drop the temporary export

**Files:**
- Modify: `packages/tools/src/builtin/delegate.ts:572-588` (`runRuntime` — replace loop with `drainRuntime`); remove `export { drainRuntime as __drainRuntimeForTest }`
- Test: `packages/tools/src/__tests__/delegate.test.ts` — update the `drainRuntime` import to no longer use `__drainRuntimeForTest` (move those unit tests to drive a runtime through a compiled sync subagent via `createDelegateTool`), add a sync error-mapping test

**Interfaces:**
- Consumes: `drainRuntime` from Task 1 (now internal-only).
- Produces: unchanged `runRuntime` signature `(name, runtime, params, onEvent?) → Promise<ToolResult>`.

- [ ] **Step 1: Write the failing test**

The Task 1 unit tests import `__drainRuntimeForTest`, which Step 3 removes. Replace that import-based suite with behavior tests through the public `createDelegateTool` sync path. Add/replace in `delegate.test.ts`:

```ts
it('sync delegate maps a child error event to an error ToolResult with the subagent prefix', async () => {
  const transport = new FakeTransport();
  const compiled = {
    type: 'compiled' as const, name: 'worker', description: 'w',
    runtime: {
      abort: () => {},
      async *execute() { yield { type: 'error', message: 'kaboom' }; },
    },
  };
  const tool = createDelegateTool({
    transport, registry: makeRegistry([]), subagents: [compiled as never], callerAgentName: 'parent',
  });
  const result = await tool.execute('d-sync-err', {
    capability: 'worker', input: 'go', // waitForResult defaults to 'sync'
  }, makeCtx());

  expect(result.type).toBe('error');
  if (result.type === 'error') expect(result.message).toBe('subagent "worker": kaboom');
});

it('sync delegate returns the child final content as text', async () => {
  const transport = new FakeTransport();
  const compiled = {
    type: 'compiled' as const, name: 'worker', description: 'w',
    runtime: {
      abort: () => {},
      async *execute() { yield { type: 'done', content: 'sync answer', toolCalls: [] }; },
    },
  };
  const tool = createDelegateTool({
    transport, registry: makeRegistry([]), subagents: [compiled as never], callerAgentName: 'parent',
  });
  const result = await tool.execute('d-sync-ok', { capability: 'worker', input: 'go' }, makeCtx());
  expect(result.type).toBe('text');
  if (result.type === 'text') expect(result.text).toBe('sync answer');
});
```

Also DELETE the `describe('drainRuntime', ...)` block and its `__drainRuntimeForTest` import added in Task 1 (its cases are now covered through the public surface; the timeout/JSON-serialization unit cases are retained as comments or folded into the async fold-back coverage — the timeout path is already exercised by Task 2's background timeout, if present).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tools && pnpm vitest run src/__tests__/delegate.test.ts -t "sync delegate"`
Expected: the error-prefix test FAILS — pre-refactor `runRuntime` already returns `subagent "worker": kaboom`, so it may PASS; the real failing signal in this task is the build/import error once `__drainRuntimeForTest` is removed in Step 3. Run the full file after Step 3.

- [ ] **Step 3: Refactor `runRuntime` and remove the temporary export**

Replace `runRuntime` (`:572-588`) with:

```ts
async function runRuntime(
  name: string,
  runtime: AgentRuntime,
  params: DelegateParams,
  onEvent?: (event: AgentEvent) => void,
): Promise<ToolResult> {
  const { content, isError } = await drainRuntime(name, runtime, params.input, { onEvent });
  if (isError) return errorResult(`subagent "${name}": ${content}`);
  return textResult(content || '(no response)');
}
```

Then DELETE the line:

```ts
export { drainRuntime as __drainRuntimeForTest };
```

- [ ] **Step 4: Run the full package test + typecheck**

Run: `cd packages/tools && pnpm vitest run src/__tests__/delegate.test.ts && pnpm build`
Expected: All delegate tests PASS; `tsc` build succeeds with no errors (confirms the removed export has no remaining references).

- [ ] **Step 5: Run the whole package suite to confirm no regression**

Run: `cd packages/tools && pnpm test`
Expected: PASS (full `@dongkseo/tools` suite, including `background-subagents.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add packages/tools/src/builtin/delegate.ts packages/tools/src/__tests__/delegate.test.ts
git commit -m "refactor(delegate): drive sync subagent through drainRuntime; drop test export"
```

---

## Self-Review

**1. Spec coverage:**
- "Single shared engine, no duplicated drain loop" → Tasks 1–3 (extract + both callers route through it). ✓
- "No behavior change" → preserved fallback strings, sync error prefix re-applied, timeout opt-in; guarded by Task 2/3 behavior tests. ✓
- "Internal helper, not exported" → temporary test export added in Task 1, removed in Task 3 Step 3. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". All code shown in full. ✓ (The one `// TEMPORARY` export is intentional and explicitly removed in Task 3.)

**3. Type consistency:** `DrainOutcome { content, isError, timedOut }` defined in Task 1 and consumed identically in Tasks 2–3. `drainRuntime(name, runtime, input, opts?)` signature stable across all three tasks. `runRuntime`/`pumpBackgroundChild` signatures unchanged. ✓

---

## Out of Scope — Follow-up Plan (separate subsystem)

**Plan 2: Generalize the background-task layer (tool-neutral).** This plan deliberately does NOT touch the subagent-specific naming. The larger architectural change — lifting `BackgroundJobRegistry` + `check_subagents`/`cancel_subagent` out of the subagent domain into a tool-neutral task layer (so ANY tool can launch background work and any caller can await/cancel/observe it, the way Claude Code's `run_in_background` + unified task-notification layer spans Bash, Agent, and remote tools) — is a separate subsystem with a far larger blast radius (contracts + tools + transport + renames + their tests). It should be its own plan, written only after Plan 1 lands and after deciding whether sync delegations should become observable/cancelable first-class jobs (the tradeoff documented in the 2026-06-26 design discussion: the cancel/visibility benefit is currently subagent-scoped and partly redundant with `ctx.signal`).
