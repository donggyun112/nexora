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
