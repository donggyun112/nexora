import { describe, it, expect } from 'vitest';
import { createExecTool } from '../builtin/exec.js';
import { createReadTaskOutputTool } from '../builtin/background-tasks.js';
import { InMemoryBackgroundTaskRegistry } from '@dongkseo/contracts';
import type { ToolContext } from '@dongkseo/contracts';

function ctx(reg: InMemoryBackgroundTaskRegistry): ToolContext {
  return {
    tenantId: 't', workdir: process.cwd(),
    secrets: { get: async () => undefined },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    backgroundTasks: reg,
  } as ToolContext;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('exec run_in_background', () => {
  it('launches echo in background, settles done, and captures stdout', async () => {
    const reg = new InMemoryBackgroundTaskRegistry();
    const exec = createExecTool({ allowList: ['echo'] });
    const read = createReadTaskOutputTool();

    const res = await exec.execute('e1', { argv: ['echo', 'hello-bg'], run_in_background: true }, ctx(reg));
    expect(res.type).toBe('text');
    const id = reg.list()[0]!.taskId;

    await sleep(200); // let echo finish + close fire
    expect(reg.get(id)?.status).toBe('done');

    const out = await read.execute('r1', { task_id: id }, ctx(reg));
    expect(out.type).toBe('text');
    if (out.type === 'text') expect(out.text).toContain('hello-bg');
  });

  it('cancel_task kills a long-running background process', async () => {
    const reg = new InMemoryBackgroundTaskRegistry();
    const exec = createExecTool({ allowList: ['sleep'] });
    await exec.execute('e2', { argv: ['sleep', '30'], run_in_background: true }, ctx(reg));
    const id = reg.list()[0]!.taskId;
    expect(reg.get(id)?.status).toBe('running');
    expect(reg.cancel(id)).toBe(true);
    await sleep(100);
    expect(reg.get(id)?.status).toBe('cancelled');
  });

  it('errors when run_in_background without a registry', async () => {
    const exec = createExecTool({ allowList: ['echo'] });
    const res = await exec.execute('e3', { argv: ['echo', 'x'], run_in_background: true },
      { tenantId: 't', workdir: process.cwd(), secrets: { get: async () => undefined }, logger: { info() {}, warn() {}, error() {} } } as ToolContext);
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toMatch(/not supported|registry/i);
  });

  it('read_task_output errors on unknown id', async () => {
    const reg = new InMemoryBackgroundTaskRegistry();
    const read = createReadTaskOutputTool();
    const res = await read.execute('r2', { task_id: 'nope' }, ctx(reg));
    expect(res.type).toBe('error');
  });
});
