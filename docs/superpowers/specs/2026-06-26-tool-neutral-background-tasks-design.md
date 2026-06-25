# Tool-Neutral Background-Task Layer — Design

**Date:** 2026-06-26
**Status:** Approved (full generalization — no scope-down)

## Problem

The background-task machinery (`BackgroundJobRegistry`, `check_subagents`, `cancel_subagent`, `deliverResult`) lives in `packages/tools/src/builtin/background-subagents.ts` and is hard-bound to the subagent/delegate domain — in its naming (`childName`, `capability`, `subagent`), its data model, and the fact that only `delegate` can launch a job. Yet the genuinely general async primitives already live in the contract layer: `ctx.steerSelf` (live-turn fold, wired in `execution-harness.ts:161`) and `suspendResult`. The job-registry layer is the odd one out — its `*_subagent` naming is the tell that it was never meant to be general.

Goal: lift the background-task layer into a **tool-neutral primitive any tool can use**, wired through the real runtime — not a rename, the full thing.

## Current State (verified)

- `steerSelf`: **wired** in `LocalExecutionHarness.execute()` (`:161`), backed by `pendingSteers` + `drainSteers` (`:174`, `:305`). Live-turn fold works in production.
- `deliverResult` (post-turn sink), `jobRegistry`, `check_subagents`/`cancel_subagent`: **unwired** in production. Only `delegate` holds a private default registry; control tools are never registered; `deliverResult` is a `DelegateToolOptions` field nothing constructs. Latent plumbing + tests only.
- `examples/auto-work-flow` uses `createDelegateTool` without any background option. No other consumer.
- `onSuspend` (`LocalExecutionHarnessOptions.onSuspend`, `:52`) is the established pattern for an app-provided, optional, runtime-forwarded hook. `deliverResult` and the registry follow the same pattern.

## Design

### 1. contracts — generic types + ToolContext surface

New file `packages/contracts/src/background-task.ts`:

```ts
export type BackgroundTaskStatus = 'running' | 'done' | 'error' | 'cancelled';

/** A tool-launched background task tracked by the parent runtime. Tool-neutral:
 *  `kind` identifies the launching tool family (e.g. 'subagent'), `label` is a
 *  human-readable name for display in check_tasks. */
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

/** Per-parent-runtime registry of background tasks. Shared between the launching
 *  tool(s) and the check_tasks / cancel_tasks control tools. */
export interface BackgroundTaskRegistry {
  register(task: { taskId: string; kind: string; label: string; startedAt: number; abort: () => void }): void;
  settle(taskId: string, status: Exclude<BackgroundTaskStatus, 'running'>, settledAt: number): void;
  cancel(taskId: string): boolean;
  list(): BackgroundTaskSnapshot[];
  get(taskId: string): BackgroundTask | null;
}
```

`ToolContext` (in `tool.ts`) gains two optional fields, runtime-injected like `steerSelf`:

```ts
/** Shared per-runtime background-task registry. Any tool that launches detached
 *  work registers it here so the parent can observe/cancel it via check_tasks /
 *  cancel_task. Undefined when the runtime doesn't support background tasks. */
backgroundTasks?: BackgroundTaskRegistry;

/** Post-turn result sink. When a background task settles after the parent turn
 *  has ended (steerSelf returned false / is absent), the result is delivered
 *  here. The app wires this to start a new turn carrying the result. Undefined
 *  → the result is logged and dropped (current default). */
deliverResult?: (result: BackgroundTaskResult) => void | Promise<void>;
```

`BackgroundTaskResult` etc. are re-exported from `contracts/index.ts`.

### 2. registry impl → contracts; control tools → tools

Dependency reality (verified): `core` and `tools` both depend only on `@dongkseo/contracts`; **tools does not depend on core** and core does not depend on tools. So the registry impl class goes in **contracts** — the shared base both already import — alongside the interface. contracts already ships runtime impl (`messageId`, `textResult`, `suspendResult`), and a pure in-memory Map registry has no external deps, so it fits (unlike the store-backed suspended-turn impls). This avoids any new package dependency or circular risk.

`packages/contracts/src/background-task.ts` (interface + default impl):
- `class InMemoryBackgroundTaskRegistry implements BackgroundTaskRegistry`. Same internals as today's `BackgroundJobRegistry` (Map, `maxSettledRetained` eviction, prune). `register({ jobId, childName, capability, runtime, startedAt })` → `register({ taskId, kind, label, startedAt, abort })`. The registry stores an `abort` callback instead of a live `runtime` (decouples it from `AgentRuntime` — tool-neutral). `cancel()` calls the stored `abort()` instead of `runtime.abort()`.
- Uses the contract's `BackgroundTask`/`BackgroundTaskSnapshot`/`BackgroundTaskStatus`. Re-exported from `contracts/index.ts`.

`packages/tools/src/builtin/background-subagents.ts` → `background-tasks.ts` (control tools only):
- `createCheckSubagentsTool`/`createCancelSubagentTool` → `createCheckTasksTool`/`createCancelTasksTool`. Tool names `check_subagents`/`cancel_subagent` → `check_tasks`/`cancel_task`. Descriptions reworded "background subagents" → "background tasks". `SubagentControlToolOptions` → `TaskControlToolOptions` (`{ registry: BackgroundTaskRegistry }`).
- No back-compat aliases for the renamed tools — verified zero production consumers (only delegate + tests).

### 3. delegate.ts — becomes a consumer of the generic layer

- Imports `BackgroundTaskRegistry`/`BackgroundTaskResult`/`InMemoryBackgroundTaskRegistry` from contracts (the latter for the default instance when neither ctx nor options supply one).
- `startBackgroundSubagent` registers with `kind: 'subagent'`, `label: childName`, `abort: () => childRuntime.abort()`.
- Registry source order: `ctx.backgroundTasks ?? options.jobRegistry ?? defaultRegistry`. Delivery sink: `ctx.deliverResult ?? options.deliverResult`. (Options retained as overrides for back-compat; ctx is primary.)
- `BackgroundSubagentResult` → kept as a deprecated type alias `= BackgroundTaskResult` (mapping `childName→label`, adding `kind:'subagent'`, `taskId`). External delegate behavior (launched message, fold-back, cancel) unchanged.
- `pumpBackgroundChild` settles via the registry and folds via `steerSelf`/`deliverResult` — already does; only the result shape generalizes.

### 4. core/execution-harness — wire it (onSuspend pattern)

- `LocalExecutionHarnessOptions` gains `backgroundTasks?: BackgroundTaskRegistry` and `deliverResult?: (r: BackgroundTaskResult) => void | Promise<void>`.
- The harness holds a registry: `this.backgroundTasks = options.backgroundTasks ?? new InMemoryBackgroundTaskRegistry()` (imported from `@dongkseo/contracts`). (Layering: interface + impl in contracts; core constructs the default; tools' control tools and delegate consume the same instance via ctx.)
- At `:158`, inject alongside `steerSelf`: `backgroundTasks: this.backgroundTasks`, `deliverResult: this.deliverResult`.

### 5. exports + tests

- `tools/builtin/index.ts`: export the relocated/renamed control-tool symbols (`createCheckTasksTool`, `createCancelTasksTool`, `TaskControlToolOptions`). The registry type/impl is exported from `@dongkseo/contracts`, not tools.
- `background-subagents.test.ts` → `background-tasks.test.ts`: rename symbols, tool names, `childName`→`label`/`kind`. Behavior assertions preserved.
- `delegate.test.ts`: behavior unchanged (already green from Plan 1).
- Add: a contracts type test for the new types; a harness test asserting `backgroundTasks` + `deliverResult` are injected into ToolContext.

## Data Flow (unchanged externally)

```
tool launches work → ctx.backgroundTasks.register({kind,label,abort})
   → detached pump drains → settle(taskId, done|error)
   → live turn?  ctx.steerSelf(msg)  : ctx.deliverResult(result)
parent observes/cancels → check_tasks / cancel_task over the same registry
```

## Error Handling

- Registry `cancel()` returns false for unknown/already-settled tasks (unchanged).
- `deliverResult` throw is caught + logged (`delegate.background.deliver_failed`), unchanged.
- No `backgroundTasks` in ctx → tool falls back to its own option/default registry (delegate) or no-ops (other tools).

## Testing Strategy

- contracts: type-level test for the new interfaces.
- core: registry impl unit tests (register/settle/cancel/prune); harness injection test.
- tools: relocated control-tool tests (`check_tasks`/`cancel_task`); delegate background behavior tests (fold-back, cancel, timeout) preserved.

## Scope Boundary (YAGNI)

- We do NOT implement an app-level "new-turn starter" for `deliverResult` — that is adapter territory (discord/gateway own conversation turns). `deliverResult` stays an injected optional sink, default undefined → log+drop (current behavior). The layer is now *ready* for any adapter to wire.
- We do NOT migrate other tools to launch background tasks — none need it yet. The primitive is exposed; adoption is incremental.

## Blast Radius

`packages/contracts` (new types + ToolContext fields), `packages/core` (registry impl + harness wiring), `packages/tools` (relocate/rename + delegate consumer), and their tests. Behavior-compatible; delegate's external contract preserved.
