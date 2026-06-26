import { describe, it, expect, vi } from 'vitest';
import { armTrigger, createIntervalSource, InMemoryTriggerHost } from '../trigger.js';

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

describe('createIntervalSource', () => {
  it('emits to subscribers on each interval and stops on unsubscribe', () => {
    vi.useFakeTimers();
    try {
      const src = createIntervalSource(1000);
      let ticks = 0;
      const off = src.subscribe(() => { ticks++; });
      vi.advanceTimersByTime(3000);
      expect(ticks).toBe(3);
      off();
      vi.advanceTimersByTime(2000);
      expect(ticks).toBe(3); // unsubscribed
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('InMemoryTriggerHost', () => {
  it('arms a recurring timer monitor, fires up to maxFires, then auto-drops from list', () => {
    vi.useFakeTimers();
    try {
      const host = new InMemoryTriggerHost();
      let fires = 0;
      const id = host.arm({
        label: 'check-x', source: createIntervalSource(1000),
        onFire: () => { fires++; }, recurring: true, maxFires: 2, fireOnArm: false, now: 0,
      });
      expect(host.list().map((m) => m.id)).toEqual([id]);
      vi.advanceTimersByTime(5000);
      expect(fires).toBe(2);            // capped
      expect(host.list()).toEqual([]);  // auto-removed after maxFires
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel stops the timer and removes the monitor', () => {
    vi.useFakeTimers();
    try {
      const host = new InMemoryTriggerHost();
      let fires = 0;
      const id = host.arm({ label: 'm', source: createIntervalSource(1000), onFire: () => { fires++; }, recurring: true, maxFires: 100, fireOnArm: false, now: 0 });
      vi.advanceTimersByTime(1000);
      expect(fires).toBe(1);
      expect(host.cancel(id)).toBe(true);
      vi.advanceTimersByTime(5000);
      expect(fires).toBe(1);            // timer torn down
      expect(host.list()).toEqual([]);
      expect(host.cancel(id)).toBe(false); // already gone
    } finally {
      vi.useRealTimers();
    }
  });

  it('ttlMs auto-cancels the monitor after the deadline', () => {
    vi.useFakeTimers();
    try {
      const host = new InMemoryTriggerHost();
      let fires = 0;
      host.arm({ label: 'm', source: createIntervalSource(1000), onFire: () => { fires++; }, recurring: true, maxFires: 100, ttlMs: 2500, fireOnArm: false, now: 0 });
      vi.advanceTimersByTime(10_000);
      expect(fires).toBe(2);            // only ticks before ttl (1000, 2000)
      expect(host.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
