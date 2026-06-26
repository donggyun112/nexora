# Event-Driven Monitoring — `when(source, condition) → wake` — Architecture & Decomposition

**Date:** 2026-06-26
**Status:** Architecture proposal (awaiting first-slice approval)
**Scope note:** This is a multi-subsystem program, not one plan. This doc is the north star + phased decomposition. Each phase is its own spec→plan→implement cycle.

## North Star

A single agent-facing primitive: **arm a trigger that wakes the agent when a condition becomes true over an event source.** Polling/cron is just the degenerate "source = clock" case; the real model is event-driven and condition-based:

```
if (condition over an event source) → event → trigger → wake(agent)
```

This subsumes today's scattered ideas (watch_task, self-scheduling cron, shell monitoring, inbox watching) into one abstraction.

## Why this shape

- Nexora is **already event-driven**: transport/topic/subscribe + `bootstrapAgent` = `message(event) → wake(agent run)`. `watch_task` (built) = registry observer `→ settle(event) → steer(wake)`. So the substrate exists; we are generalizing, not re-architecting.
- Cron (time polling) is wasteful (most wakes find nothing) and latency-bound. Condition/event triggers wake **only when it matters**. Cron becomes one source among many.
- Reference (this agent's own harness): **Monitor** (event stream — each stdout line is an event, condition baked into a shell `grep` pipeline → push notification), **Bash run_in_background** (completion trigger), **CronCreate** (timer), **ScheduleWakeup** (self-paced self-wake). The unified UX = "you get notified, you don't poll." We mirror that.

## Core Abstraction

```ts
// A pluggable event source. The host subscribes; the source emits events.
interface EventSource<E = unknown> {
  subscribe(onEvent: (event: E) => void): () => void; // returns unsubscribe
}

// A trigger = source + predicate + wake action, armed by the agent.
interface Trigger {
  id: string;
  evaluate(event: unknown, ctx: TriggerEvalContext): boolean; // the `if`
  recurring: boolean;       // one-shot (until) vs repeating (monitor)
  maxFires?: number;        // guardrail
  wake(summary: string): void; // steerSelf (live) | publish→bootstrap (asleep)
}

// Runtime-hosted: subscribes each armed trigger to its source, evaluates the
// predicate on each event, fires wake on match, deregisters one-shots. The
// evaluator is NON-LLM (cheap), so it can run continuously while the agent sleeps.
class TriggerHost { arm(trigger, source): void; cancel(id): boolean; list(): TriggerSnapshot[]; }
```

**Sources (each a thin `EventSource`):**
- **task** — `BackgroundTaskRegistry.subscribe` (settle/cancel). Already built. `watch_task` becomes `when(source:task, condition:settled)`.
- **timer** — `CronScheduler` interval/cron ticks. Condition = "always". This is the cron/self-monitor case.
- **stream** — `AuditStore` stdout entries (`query(since)` / a push tap). Condition = regex/contains. This is shell monitoring.
- **topic** — transport messages on a subscribed topic. Condition = match. This is inbox watching.

**Wake delivery (shared, exists):** `ctx.steerSelf` if the turn is live; else publish a wake envelope to the agent's own topic → `bootstrapAgent` runs it (asleep case). For asleep/recurring, the host needs transport + the agent's topic (constructed-in, like delegate).

**Condition vocabulary (minimal — no arbitrary DSL):**
- task: `status in {done|error|cancelled|settled}`, `mode: all|any`
- stream: `contains` / `regex` over the new lines
- topic: `type` / payload field match
- timer: always (the tick *is* the event)

**Guardrails (mandatory):** `maxFires`, `until` (deadline), budget awareness, evaluator is pure-predicate (no LLM). Recurring triggers auto-expire (mirror harness cron's 7-day cap). Agent can `cancel_trigger`.

## Agent-facing tools (unified)

- `when({ source, condition, recurring?, until?, max_fires?, message? })` → arm a trigger, return immediately (non-blocking). 
- `cancel_trigger({ id })`, `list_triggers()`.
- `watch_task` is kept as a thin sugar over `when(source:task)` (back-compat) OR folded in.

## Decomposition (phased — each shippable on its own)

| Phase | Deliverable | New infra | Risk |
|---|---|---|---|
| **0. Foundation** | `EventSource`/`TriggerHost`/`Trigger` + **task source** (subsume watch_task). Validates the abstraction on infra we already have (registry observer + steerSelf). | contracts + a host in core; refactor watch_task | low |
| **1. Timer source** | wire `CronScheduler` into `TriggerHost`; `when(source:timer, every:N, recurring)`. Self-scheduling/recurring monitor + guardrails + asleep-wake via self-publish. | CronScheduler runtime wiring; transport wake | med (runtime wiring) |
| **2. Stream source (shell monitoring)** | `background-exec` (run_in_background) records stdout → `AuditStore`; `when(source:stream, regex)`. The "monitor a shell" case end-to-end. | background-exec producer + audit tap | med-high |
| **3. Topic source (inbox)** | transport subscription seam on the host; `when(source:topic, match)`. | transport seam; double-delivery policy | med |

## Recommended first slice

**Phase 0 + Phase 1 together** as the first spec→implement cycle:
- Phase 0 locks the abstraction on existing infra (low risk, reuses the registry observer we built).
- Phase 1 adds the genuinely new capability the user asked for first — a **self-scheduling / recurring trigger** (timer source) with asleep-wake + guardrails — riding the existing `CronScheduler` class and `bootstrapAgent` publish path.
- Phase 2 (shell monitoring via audit stream) is the highest-value follow-up but needs the new `background-exec` producer, so it's its own cycle.

Rationale: Phase 0 alone is mostly refactor (low new value); Phase 1 alone needs the abstraction Phase 0 defines. Together they deliver the unified primitive **and** a new capability, on mostly-existing substrate.

## Open decisions (resolved here; flag if you disagree)

1. **Asleep-wake mechanism** → publish wake envelope to the agent's own topic, reuse `bootstrapAgent` (no new invoke path). For Phase 0 (task source, live turn) `steerSelf` suffices; asleep-wake lands in Phase 1.
2. **Evaluator location** → runtime-hosted, non-LLM predicate matcher (cheap, runs while agent sleeps). Mirrors how Monitor runs a shell pipeline as the evaluator.
3. **Ephemeral vs durable** → Phase 0/1 ephemeral (host lives with the runtime); durable (persist armed triggers to a store, reload on boot) is a later cross-cutting add — `ScheduledJob` store already models the durable timer case.
4. **Condition DSL** → minimal structured matchers only (status/regex/contains/type). No arbitrary code.

## What exists vs what's new (grounded)

- ✅ exists: `BackgroundTaskRegistry.subscribe` (task events), `CronScheduler` class (timer, **unwired**), `AuditStore.record/query(since)` (stream sink), transport + `bootstrapAgent` (wake path), `ScheduledJob` store (durable timer model), `ctx.steerSelf`/`deliverResult`.
- 🔨 new: `EventSource`/`TriggerHost` abstraction, runtime hosting + asleep-wake wiring, `background-exec` producer (Phase 2), `when`/`cancel_trigger`/`list_triggers` tools, condition matchers, guardrails.
