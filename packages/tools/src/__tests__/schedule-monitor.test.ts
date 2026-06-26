import { describe, it, expect, vi } from 'vitest';
import { createScheduleMonitorTool, createCancelMonitorTool, createListMonitorsTool, createWatchOutputTool } from '../builtin/schedule-monitor.js';
import { InMemoryTriggerHost, InMemoryBackgroundTaskRegistry } from '@dongkseo/contracts';
import type { ToolContext } from '@dongkseo/contracts';

function ctx(host: InMemoryTriggerHost, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    tenantId: 't', workdir: '/tmp', secrets: { get: async () => undefined },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    triggers: host, ...extra,
  } as ToolContext;
}

describe('schedule_monitor', () => {
  it('arms a recurring monitor that wakes via steerSelf on each tick (bounded by max_fires)', async () => {
    vi.useFakeTimers();
    try {
      const host = new InMemoryTriggerHost();
      const woke: string[] = [];
      const tool = createScheduleMonitorTool();
      const res = await tool.execute('s1',
        { prompt: 'check the queue', every_ms: 1000, max_fires: 2 },
        ctx(host, { steerSelf: (m: string) => { woke.push(m); return true; } }));
      expect(res.type).toBe('text');
      vi.advanceTimersByTime(5000);
      expect(woke).toHaveLength(2);          // capped at max_fires
      expect(woke[0]).toContain('check the queue');
    } finally {
      vi.useRealTimers();
    }
  });

  it('floors the interval and requires a bound', async () => {
    const host = new InMemoryTriggerHost();
    const tool = createScheduleMonitorTool();
    const tooFast = await tool.execute('s2', { prompt: 'x', every_ms: 10, max_fires: 1 }, ctx(host));
    expect(tooFast.type).toBe('text'); // accepted but floored
    const unbounded = await tool.execute('s3', { prompt: 'x', every_ms: 1000 }, ctx(host));
    expect(unbounded.type).toBe('error'); // neither max_fires nor ttl_ms → rejected
  });

  it('errors when the runtime has no trigger host', async () => {
    const tool = createScheduleMonitorTool();
    const res = await tool.execute('s4', { prompt: 'x', every_ms: 1000, max_fires: 1 },
      { tenantId: 't', workdir: '/tmp', secrets: { get: async () => undefined }, logger: { info() {}, warn() {}, error() {} } } as ToolContext);
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toMatch(/not supported/i);
  });

  it('list_monitors shows armed monitors; cancel_monitor stops one', async () => {
    vi.useFakeTimers();
    try {
      const host = new InMemoryTriggerHost();
      const schedule = createScheduleMonitorTool();
      const list = createListMonitorsTool();
      const cancel = createCancelMonitorTool();
      await schedule.execute('s5', { prompt: 'watch', every_ms: 1000, max_fires: 100 }, ctx(host));

      const listed = await list.execute('l1', {}, ctx(host));
      expect(listed.type).toBe('text');
      const monitors = JSON.parse((listed as { text: string }).text);
      expect(monitors).toHaveLength(1);
      const id = monitors[0].id;

      const cancelled = await cancel.execute('c1', { monitor_id: id }, ctx(host));
      expect(cancelled.type).toBe('text');
      expect(host.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('watch_output', () => {
  function regCtx(reg: InMemoryBackgroundTaskRegistry, host: InMemoryTriggerHost, steer?: (m: string) => boolean): ToolContext {
    return {
      tenantId: 't', workdir: '/tmp', secrets: { get: async () => undefined },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      backgroundTasks: reg, triggers: host, steerSelf: steer,
    } as ToolContext;
  }

  it('fires when the pattern later appears in task output (one-shot, then tears down)', async () => {
    vi.useFakeTimers();
    try {
      const reg = new InMemoryBackgroundTaskRegistry();
      const host = new InMemoryTriggerHost();
      let out = 'starting build...';
      reg.register({ taskId: 't1', kind: 'bash', label: 'build', startedAt: 0, abort: () => {}, readOutput: () => out });
      const woke: string[] = [];
      const tool = createWatchOutputTool();
      const res = await tool.execute('w1', { task_id: 't1', pattern: 'ERROR', poll_ms: 1000 },
        regCtx(reg, host, (m) => { woke.push(m); return true; }));
      expect(res.type).toBe('text');

      vi.advanceTimersByTime(2000);
      expect(woke).toHaveLength(0);            // no match yet
      out = 'oops: ERROR: build failed';
      vi.advanceTimersByTime(1000);
      expect(woke).toHaveLength(1);
      expect(woke[0]).toContain('ERROR');
      expect(host.list()).toEqual([]);         // one-shot torn down
      vi.advanceTimersByTime(5000);
      expect(woke).toHaveLength(1);            // no re-fire
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires immediately if the output already matches', async () => {
    const reg = new InMemoryBackgroundTaskRegistry();
    const host = new InMemoryTriggerHost();
    reg.register({ taskId: 't2', kind: 'bash', label: 'b', startedAt: 0, abort: () => {}, readOutput: () => 'already ERROR here' });
    const woke: string[] = [];
    const tool = createWatchOutputTool();
    await tool.execute('w2', { task_id: 't2', pattern: 'ERROR' }, regCtx(reg, host, (m) => { woke.push(m); return true; }));
    expect(woke).toHaveLength(1);
  });

  it('rejects invalid regex / unknown task / output-less task / no runtime support', async () => {
    const reg = new InMemoryBackgroundTaskRegistry();
    const host = new InMemoryTriggerHost();
    reg.register({ taskId: 't3', kind: 'bash', label: 'b', startedAt: 0, abort: () => {} }); // no readOutput
    const tool = createWatchOutputTool();
    const noOut = await tool.execute('w3', { task_id: 't3', pattern: 'x' }, regCtx(reg, host));
    expect(noOut.type).toBe('error');
    const unknown = await tool.execute('w4', { task_id: 'ghost', pattern: 'x' }, regCtx(reg, host));
    expect(unknown.type).toBe('error');
    const badRe = await tool.execute('w5', { task_id: 't3', pattern: '(' }, regCtx(reg, host));
    expect(badRe.type).toBe('error');
    const noHost = await tool.execute('w6', { task_id: 't3', pattern: 'x' },
      { tenantId: 't', workdir: '/tmp', secrets: { get: async () => undefined }, logger: { info() {}, warn() {}, error() {} }, backgroundTasks: reg } as ToolContext);
    expect(noHost.type).toBe('error');
  });
});
