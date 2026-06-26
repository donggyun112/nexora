# `watch_task` — Agent-Set Task Triggers — Design

**Date:** 2026-06-26
**Status:** Proposed (awaiting approval)

## Problem

The background-task layer lets an agent launch detached work (`delegate waitForResult:'async'`) and observe it via `check_tasks` (poll) / `cancel_task`. But the agent cannot express *"wake me when task T (or all of T1..Tn) is done."* Today only a single delegate task's completion folds back automatically (via `steerSelf` on settle). There's no agent-controlled, multi-task **trigger** — an `until`-style condition that fires once the watched tasks settle.

Goal: a built-in tool that lets the agent **arm a non-blocking trigger** on one or more background tasks; when the condition is met, a message is folded into the agent's turn (live) or delivered as a follow-up.

## Non-Goals (YAGNI / deferred)

- **Blocking wait.** Not a design decision — blocking vs non-blocking is already an optional knob in the background infra (`waitForResult`, `drainRuntime`, `steerSelf`/`deliverResult`). Monitoring is non-blocking by nature, and a blocking watch would stall the loop (non-concurrency-safe tools run sequentially in `executeBatch`). So: **non-blocking only.**
- **`while … do` (repeated firing).** One-shot `until` only for now. Periodic/heartbeat triggers deferred.
- **Condition DSL** — output-content matching, progress thresholds. Deferred. The condition vocabulary is just terminal-state join.

## Design

### Mechanism: ride the existing primitives

The runtime already injects onto `ToolContext`: `backgroundTasks` (the shared `BackgroundTaskRegistry`), `steerSelf` (live-turn fold), `deliverResult` (post-turn sink). The watch tool needs **no new core/harness wiring** — it arms a trigger using these. The only new contract surface is a way to be notified of registry state changes.

### 1. contracts — registry subscription

Add to `BackgroundTaskRegistry` (interface + `InMemoryBackgroundTaskRegistry`):

```ts
/** Subscribe to terminal state transitions (settle/cancel). Returns an
 *  unsubscribe fn. Fires AFTER the task's status is updated. */
subscribe(listener: (taskId: string, status: BackgroundTaskStatus) => void): () => void;
```

`InMemoryBackgroundTaskRegistry` holds a `Set<listener>`; `settle()` and `cancel()` notify after updating status (register stays silent — only terminal transitions matter for triggers). Listener errors are swallowed (one bad listener can't break settle).

### 2. tools — `createWatchTaskTool` (in `background-tasks.ts`)

A built-in tool, tool-neutral (works for any `kind` of task):

```ts
watch_task({
  task_ids: string[],          // tasks to watch
  mode?: 'all' | 'any',        // default 'all' — fire when all (or any) settle
  message?: string,            // optional note included in the fired message
})
```

Behavior (non-blocking, one-shot):
1. Read `ctx.backgroundTasks`. If absent → error ("background tasks unsupported in this runtime").
2. Validate `task_ids` non-empty; unknown ids are reported but don't block (a watch on an unknown id can never fire → reject with an error listing unknown ids, so the agent doesn't arm a dead trigger).
3. Compute already-settled set via `registry.get`. If the condition is **already satisfied**, fire immediately (synchronously build the message; deliver via the same channel as below) and return.
4. Otherwise `subscribe`; on each terminal transition, re-evaluate `mode` over `task_ids`. When satisfied: unsubscribe (one-shot), build the message, deliver.
5. **Delivery channel:** `ctx.steerSelf(msg)` if it returns true (live turn); else `ctx.deliverResult({ ...synthetic task result })`; else log+drop. (Same fallback ladder delegate already uses.)
6. Return immediately: `"Watching N task(s) (mode=all); you'll be notified when they settle."`

**Fired message** reports each watched task's final status so the agent learns done-vs-error without another `check_tasks`:
```
[watch] tasks settled (mode=all): t1=done, t2=error. <message>
```

`mode='all'` fires when every watched task is terminal; `mode='any'` fires on the first. Terminal = done | error | cancelled. (No `done`-only/`error`-only filter yet — the agent reads the reported statuses. This avoids the "waits forever because a task errored instead of done" hang.)

Concurrency flags: `isReadOnly: true`, `isConcurrencySafe: true` (arming is a pure registration; firing is async).

### 3. exports + tests

- `builtin/index.ts`: export `createWatchTaskTool`.
- contracts test: `subscribe` fires on settle/cancel, unsubscribe works, listener error isolation.
- tools test: arm → settle all → steered message with per-task statuses; `mode='any'`; already-settled immediate fire; unknown-id rejection; no-steerSelf falls back to deliverResult.

## Data Flow

```
agent: watch_task({task_ids:[t1,t2], mode:'all'})
  → ctx.backgroundTasks.subscribe(listener); return "watching 2 tasks"  (non-blocking)
... t1 settles → listener: not all terminal yet
... t2 settles → listener: all terminal → unsubscribe → steerSelf("[watch] t1=done, t2=error")
```

## Error Handling

- No `ctx.backgroundTasks` → error result (runtime lacks background tasks).
- Unknown task id(s) → error result listing them (don't arm a dead trigger).
- No `steerSelf` and no `deliverResult` when the trigger fires → log+drop (consistent with delegate).
- Listener throw inside `subscribe` notify → swallowed per-listener.

## Scope / Blast Radius

- `packages/contracts`: `subscribe` on the registry interface + impl (additive).
- `packages/tools`: new `createWatchTaskTool` in `background-tasks.ts` + export.
- No `core`/harness change (rides injected ctx). Tests in contracts + tools.

## Future (out of scope)

- `while … do` repeated triggers / heartbeat.
- `until: done|error`-specific filters and output/progress conditions.
- Other tools (besides delegate) launching tasks that watch_task can observe — already supported by the tool-neutral `kind`/`label`.
