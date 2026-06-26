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
  /** Evaluate + possibly fire at arm time (default true). Set false for clock
   *  sources where only real events (ticks) should fire, not the arm itself. */
  fireOnArm?: boolean;
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

  // Evaluate at arm time (unless the source is a clock that fires only on ticks).
  let firedImmediately = false;
  if (spec.fireOnArm ?? true) {
    const before = fires;
    tryFire();
    firedImmediately = fires > before;
  }
  // Subscribe only if still live (not a fired-and-stopped one-shot).
  if (!stopped) {
    unsubscribe = spec.subscribe(() => tryFire());
  }

  return {
    firedImmediately,
    cancel: () => stop(),
  };
}

/** A subscribable event source. The source decides when events fire. */
export interface EventSource {
  subscribe(onEvent: () => void): () => void;
  /** Tear down any backing resource (timer, watcher). Optional. */
  stop?(): void;
}

/**
 * A clock source: fires every intervalMs. The timer is unref'd so it never keeps
 * the process alive.
 */
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
    fireOnArm?: boolean;
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
    fireOnArm?: boolean;
    now: number;
  }): string {
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
      fireOnArm: spec.fireOnArm,
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
