# Monitoring Triggers — Phase 0 (Trigger Spine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a generic, source-agnostic `armTrigger` spine — "subscribe to a source, fire a wake when a predicate holds, with one-shot/recurring + maxFires guardrails" — and refactor `watch_task` onto it, so future sources (timer/stream/topic) plug in without re-implementing the trigger loop.

**Architecture:** `armTrigger({ subscribe, isSatisfied, onFire, recurring?, maxFires? })` lives in `@dongkseo/contracts` (pure, no deps; usable by tools). It fires immediately if already satisfied, else subscribes and fires on events while the predicate holds, deregistering on one-shot completion / maxFires / cancel. `watch_task` becomes a thin caller: source = `BackgroundTaskRegistry.subscribe`, predicate = task-status `all/any`.

**Tech Stack:** TypeScript (ESM `.js` specifiers), Vitest, pnpm + turbo.

## Global Constraints

- ESM `.js` import specifiers; no new deps.
- Per-package: `cd packages/<pkg> && pnpm vitest run <path>`. Root typecheck: `pnpm build`. Root tests: `pnpm test`.
- `armTrigger` is pure/synchronous-arming and non-LLM (it must be cheap enough to run continuously). No timers/IO inside it — the *source* owns when events fire.
- `watch_task` external behavior must stay identical (same two return messages, same fire payload). Existing `background-tasks.test.ts` watch_task tests must stay green.
- Build green at every commit: contracts (Task 1, additive) → tools (Task 2, refactor).

---

## File Structure

- `packages/contracts/src/trigger.ts` — **new**. `armTrigger` + `ArmedTrigger`/`TriggerSpec` types.
- `packages/contracts/src/index.ts` — **modify**. Export the new module.
- `packages/contracts/src/__tests__/trigger.test.ts` — **new**. `armTrigger` unit tests with a fake source.
- `packages/tools/src/builtin/background-tasks.ts` — **modify**. `createWatchTaskTool` uses `armTrigger`.

---

### Task 1: `armTrigger` spine (contracts)

**Files:**
- Create: `packages/contracts/src/trigger.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/__tests__/trigger.test.ts`

**Interfaces:**
- Produces: `interface TriggerSpec { subscribe: (onEvent: () => void) => () => void; isSatisfied: () => boolean; onFire: () => void; recurring?: boolean; maxFires?: number }`
- Produces: `interface ArmedTrigger { cancel: () => void; firedImmediately: boolean }`
- Produces: `function armTrigger(spec: TriggerSpec): ArmedTrigger`

Semantics: on arm, if `isSatisfied()` → `onFire()` immediately (`firedImmediately=true`), counting toward `maxFires`; otherwise subscribe. On each source event, if `isSatisfied()` → `onFire()`. After a fire: stop (unsubscribe) when not `recurring`, or when `maxFires` reached. `cancel()` unsubscribes and prevents further fires. Default `recurring=false`, `maxFires=Infinity` for recurring / `1` effectively for one-shot.

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/__tests__/trigger.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { armTrigger } from '../trigger.js';

/** Fake source: tests drive events manually via emit(). */
function fakeSource() {
  const listeners = new Set<() => void>();
  return {
    subscribe: (onEvent: () => void) => { listeners.add(onEvent); return () => listeners.delete(onEvent); },
    emit: () => { for (const l of [...listeners]) l(); },
    count: () => listeners.size,
  };
}

describe('armTrigger', () => {
  it('fires immediately and does not subscribe when already satisfied (one-shot)', () => {
    const src = fakeSource();
    let fires = 0;
    const t = armTrigger({ subscribe: src.subscribe, isSatisfied: () => true, onFire: () => { fires++; } });
    expect(t.firedImmediately).toBe(true);
    expect(fires).toBe(1);
    expect(src.count()).toBe(0); // no subscription left
  });

  it('subscribes when not satisfied, fires once when it becomes satisfied (one-shot)', () => {
    const src = fakeSource();
    let ok = false; let fires = 0;
    const t = armTrigger({ subscribe: src.subscribe, isSatisfied: () => ok, onFire: () => { fires++; } });
    expect(t.firedImmediately).toBe(false);
    src.emit(); // still not satisfied
    expect(fires).toBe(0);
    ok = true;
    src.emit(); // now satisfied
    expect(fires).toBe(1);
    src.emit(); // one-shot: already unsubscribed
    expect(fires).toBe(1);
    expect(src.count()).toBe(0);
  });

  it('recurring fires on every satisfied event until maxFires', () => {
    const src = fakeSource();
    let fires = 0;
    armTrigger({ subscribe: src.subscribe, isSatisfied: () => true, onFire: () => { fires++; }, recurring: true, maxFires: 3 });
    // fired once immediately (count 1), then 2 more events → 3 total, then stop
    src.emit(); src.emit(); src.emit();
    expect(fires).toBe(3);
    expect(src.count()).toBe(0); // stopped after maxFires
  });

  it('cancel() unsubscribes and prevents further fires', () => {
    const src = fakeSource();
    let ok = false; let fires = 0;
    const t = armTrigger({ subscribe: src.subscribe, isSatisfied: () => ok, onFire: () => { fires++; } });
    t.cancel();
    expect(src.count()).toBe(0);
    ok = true;
    src.emit();
    expect(fires).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/contracts && pnpm vitest run src/__tests__/trigger.test.ts`
Expected: FAIL — cannot resolve `../trigger.js`.

- [ ] **Step 3: Create the implementation**

Create `packages/contracts/src/trigger.ts`:

```ts
/**
 * armTrigger — source-agnostic trigger spine for event-driven monitoring.
 *
 * "Subscribe to an event source; fire a wake whenever a predicate holds."
 * The source decides WHEN events happen (registry transition, timer tick,
 * stream line, inbox message); armTrigger only wires source → predicate → wake,
 * with one-shot/recurring + maxFires guardrails. Pure and non-LLM, so it is
 * cheap enough to run continuously while the agent sleeps.
 */

export interface TriggerSpec {
  /** Subscribe to the source; return an unsubscribe fn. Called only when the
   *  trigger is not already satisfied at arm time. */
  subscribe: (onEvent: () => void) => () => void;
  /** The predicate (`if`). Re-evaluated at arm time and on each source event. */
  isSatisfied: () => boolean;
  /** The wake action, invoked on each fire. */
  onFire: () => void;
  /** Fire on every satisfied event (monitor) vs once then stop (default false). */
  recurring?: boolean;
  /** Cap total fires. Default: 1 for one-shot, Infinity for recurring. */
  maxFires?: number;
}

export interface ArmedTrigger {
  cancel: () => void;
  /** True if the predicate already held at arm time (fired without subscribing). */
  firedImmediately: boolean;
}

export function armTrigger(spec: TriggerSpec): ArmedTrigger {
  const cap = spec.maxFires ?? (spec.recurring ? Infinity : 1);
  let fires = 0;
  let unsubscribe: (() => void) | null = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  };

  const tryFire = (): void => {
    if (stopped) return;
    if (!spec.isSatisfied()) return;
    spec.onFire();
    fires++;
    if (!spec.recurring || fires >= cap) stop();
  };

  // Evaluate at arm time.
  const satisfiedAtArm = spec.isSatisfied();
  if (satisfiedAtArm) {
    tryFire();
  }
  // Subscribe only if still live (not a fired-and-stopped one-shot).
  if (!stopped) {
    unsubscribe = spec.subscribe(() => tryFire());
  }

  return {
    firedImmediately: satisfiedAtArm,
    cancel: () => stop(),
  };
}
```

- [ ] **Step 4: Add the export**

In `packages/contracts/src/index.ts`, after the background-task export block (the `export { InMemoryBackgroundTaskRegistry } ...` line), add:

```ts
export type { TriggerSpec, ArmedTrigger } from './trigger.js';
export { armTrigger } from './trigger.js';
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd packages/contracts && pnpm vitest run src/__tests__/trigger.test.ts && pnpm build`
Expected: 4 tests PASS; `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/trigger.ts packages/contracts/src/index.ts packages/contracts/src/__tests__/trigger.test.ts
git commit -m "feat(contracts): armTrigger — source-agnostic trigger spine"
```

---

### Task 2: refactor `watch_task` onto `armTrigger`

**Files:**
- Modify: `packages/tools/src/builtin/background-tasks.ts` (the `createWatchTaskTool` arm/return block)
- Test: `packages/tools/src/__tests__/background-tasks.test.ts` (existing watch_task tests — must stay green; no new tests required)

**Interfaces:**
- Consumes: `armTrigger` from `@dongkseo/contracts` (Task 1).
- Produces: `createWatchTaskTool` unchanged externally (same name, params, return messages, fire payload).

- [ ] **Step 1: Confirm the guard test (already green) covers behavior**

Run: `cd packages/tools && pnpm vitest run src/__tests__/background-tasks.test.ts -t watch_task`
Expected: 6 watch_task tests PASS (pre-refactor baseline to preserve).

- [ ] **Step 2: Refactor `createWatchTaskTool` to use `armTrigger`**

In `packages/tools/src/builtin/background-tasks.ts`:

Add `armTrigger` to the value import from contracts (the line `import { textResult, errorResult } from '@dongkseo/contracts';`) →
```ts
import { textResult, errorResult, armTrigger } from '@dongkseo/contracts';
```

Replace the tail of `createWatchTaskTool`'s `execute` — the block from `if (satisfied()) {` through the final `return textResult(...)` — with:

```ts
      const { firedImmediately } = armTrigger({
        subscribe: (onEvent) => registry.subscribe(() => onEvent()),
        isSatisfied: satisfied,
        onFire: fire,
        recurring: false,
      });
      return textResult(
        firedImmediately
          ? `Watched ${taskIds.length} task(s) — already settled; notified now.`
          : `Watching ${taskIds.length} task(s) (mode=${mode}); you'll be notified when they settle.`,
      );
```

(The `satisfied`, `fire`, `statusOf`, `isTerminal`, unknown-id and no-registry guards above this block are unchanged.)

- [ ] **Step 3: Run watch_task tests**

Run: `cd packages/tools && pnpm vitest run src/__tests__/background-tasks.test.ts`
Expected: PASS (all background-tasks tests, watch_task behavior identical).

- [ ] **Step 4: Whole-repo typecheck + test**

Run: `cd /Users/dongkseo/Project/Nexora && pnpm build && pnpm test`
Expected: all `tsc` clean; all turbo test tasks PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/builtin/background-tasks.ts
git commit -m "refactor(tools): watch_task built on the armTrigger spine"
```

---

## Self-Review

**1. Spec coverage (architecture doc Phase 0):** `EventSource`/trigger spine → `armTrigger` (Task 1). Task source subsumed → watch_task refactor (Task 2). Recurring/maxFires guardrails present in the spine (used later by timer source). One-shot semantics preserve watch_task. ✓ Asleep-wake, timer/stream/topic sources, durable persistence → explicitly Phase 1+ (not here). ✓

**2. Placeholder scan:** No TBD/TODO/vague steps; all code shown in full. ✓

**3. Type consistency:** `armTrigger(spec: TriggerSpec): ArmedTrigger` identical across Task 1 def/impl/test and Task 2 consumption. `firedImmediately` field used consistently. `subscribe: (onEvent: () => void) => () => void` matches `registry.subscribe(() => onEvent())` adapter in Task 2. ✓

---

## Next cycle (not this plan)

- **Phase 1** — timer source via `armTrigger` (`subscribe` driven by `CronScheduler`, `isSatisfied: () => true`, `recurring: true`) + asleep-wake (publish wake envelope → `bootstrapAgent`) + `when`/`cancel_trigger`/`list_triggers` tools + guardrails. Needs runtime integration → its own verified cycle.
- **Phase 2** — stream source (background-exec → AuditStore → regex predicate). Shell monitoring.
