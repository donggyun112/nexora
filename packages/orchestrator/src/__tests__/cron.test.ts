import { describe, it, expect, vi } from 'vitest';
import { CronScheduler, intervalJob, oneShotJob } from '../cron.js';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

describe('CronScheduler', () => {
  it('runs interval jobs repeatedly', async () => {
    const scheduler = new CronScheduler();
    const fn = vi.fn();
    scheduler.schedule(intervalJob('tick', 30, fn));

    await sleep(100);
    scheduler.stop();

    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('runs one-shot jobs exactly once', async () => {
    const scheduler = new CronScheduler();
    const fn = vi.fn();
    scheduler.schedule(oneShotJob('once', 20, fn));

    await sleep(80);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(scheduler.list()).toHaveLength(0);

    scheduler.stop();
  });

  it('unschedule removes pending jobs', async () => {
    const scheduler = new CronScheduler();
    const fn = vi.fn();
    scheduler.schedule(intervalJob('a', 30, fn));
    expect(scheduler.unschedule('a')).toBe(true);
    expect(scheduler.unschedule('a')).toBe(false);

    await sleep(80);
    expect(fn).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('trigger() runs immediately regardless of schedule', async () => {
    const scheduler = new CronScheduler();
    const fn = vi.fn();
    scheduler.schedule(intervalJob('b', 10_000, fn));
    await scheduler.trigger('b');
    expect(fn).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('isolates errors from later runs', async () => {
    const scheduler = new CronScheduler();
    let count = 0;
    scheduler.schedule(intervalJob('flaky', 20, () => {
      count++;
      if (count === 1) throw new Error('boom');
    }));

    await sleep(70);
    scheduler.stop();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('throws on schedule after stop', () => {
    const scheduler = new CronScheduler();
    scheduler.stop();
    expect(() => scheduler.schedule(intervalJob('x', 100, () => {}))).toThrow(/stopped/);
  });
});
