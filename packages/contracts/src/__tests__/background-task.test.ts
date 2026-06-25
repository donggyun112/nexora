import { describe, it, expect } from 'vitest';
import { InMemoryBackgroundTaskRegistry } from '../background-task.js';

function reg(max?: number) {
  return new InMemoryBackgroundTaskRegistry(max);
}

describe('InMemoryBackgroundTaskRegistry', () => {
  it('registers a running task and lists a snapshot without the abort handle', () => {
    const r = reg();
    let aborted = false;
    r.register({ taskId: 't1', kind: 'subagent', label: 'coder', startedAt: 1, abort: () => { aborted = true; } });
    const list = r.list();
    expect(list).toEqual([{ taskId: 't1', kind: 'subagent', label: 'coder', status: 'running', startedAt: 1 }]);
    expect('abort' in (list[0] as object)).toBe(false);
    expect(aborted).toBe(false);
  });

  it('settle moves a running task to a terminal status and clears abort', () => {
    const r = reg();
    r.register({ taskId: 't1', kind: 'subagent', label: 'a', startedAt: 1, abort: () => {} });
    r.settle('t1', 'done', 5);
    const t = r.get('t1');
    expect(t?.status).toBe('done');
    expect(t?.settledAt).toBe(5);
    expect(t?.abort).toBeNull();
  });

  it('settle is a no-op for an unknown or already-settled task', () => {
    const r = reg();
    r.register({ taskId: 't1', kind: 'k', label: 'a', startedAt: 1, abort: () => {} });
    r.settle('t1', 'done', 5);
    r.settle('t1', 'error', 9); // ignored — already settled
    expect(r.get('t1')?.status).toBe('done');
    r.settle('nope', 'done', 1); // unknown — no throw
  });

  it('cancel aborts a running task, marks cancelled, and returns true', () => {
    const r = reg();
    let aborted = false;
    r.register({ taskId: 't1', kind: 'k', label: 'a', startedAt: 1, abort: () => { aborted = true; } });
    expect(r.cancel('t1')).toBe(true);
    expect(aborted).toBe(true);
    expect(r.get('t1')?.status).toBe('cancelled');
  });

  it('cancel returns false for unknown or already-settled tasks', () => {
    const r = reg();
    r.register({ taskId: 't1', kind: 'k', label: 'a', startedAt: 1, abort: () => {} });
    r.settle('t1', 'done', 2);
    expect(r.cancel('t1')).toBe(false);
    expect(r.cancel('missing')).toBe(false);
  });

  it('evicts oldest settled tasks beyond the retention cap; keeps running', () => {
    const r = reg(1);
    r.register({ taskId: 'run', kind: 'k', label: 'r', startedAt: 1, abort: () => {} });
    r.register({ taskId: 's1', kind: 'k', label: 's1', startedAt: 2, abort: () => {} });
    r.register({ taskId: 's2', kind: 'k', label: 's2', startedAt: 3, abort: () => {} });
    r.settle('s1', 'done', 10);
    r.settle('s2', 'done', 11);
    const ids = r.list().map((t) => t.taskId).sort();
    expect(ids).toContain('run');   // running never evicted
    expect(ids).toContain('s2');    // newest settled kept
    expect(ids).not.toContain('s1'); // oldest settled evicted
  });
});
