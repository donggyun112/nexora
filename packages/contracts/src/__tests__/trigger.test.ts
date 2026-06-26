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
