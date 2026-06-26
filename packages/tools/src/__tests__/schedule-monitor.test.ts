import { describe, it, expect, vi } from 'vitest';
import { createScheduleMonitorTool, createCancelMonitorTool, createListMonitorsTool } from '../builtin/schedule-monitor.js';
import { InMemoryTriggerHost } from '@dongkseo/contracts';
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
