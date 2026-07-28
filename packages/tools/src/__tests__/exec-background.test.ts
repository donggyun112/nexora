import { describe, it, expect } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

  it('sandboxes the detached process via workspace.wrapCommand (no host-spawn escape)', async () => {
    const reg = new InMemoryBackgroundTaskRegistry();
    const exec = createExecTool({ allowList: ['echo'] });
    const read = createReadTaskOutputTool();

    // 워크스페이스가 있으면 detached(background) 프로세스도 래핑된 argv 로 spawn 돼야 한다 —
    // 래핑을 건너뛰면 jail 밖 호스트 실행(RCE)이 된다. 래퍼가 argv 를 바꾸는지로 검증한다.
    const wrapCommand = async (command: { argv: string[]; env?: Record<string, string> }) => ({
      argv: ['echo', 'WRAPPED', ...command.argv.slice(1)],
      env: { ...(command.env ?? {}) },
    });
    const wsCtx = { ...ctx(reg), workspace: { wrapCommand } } as unknown as ToolContext;

    const res = await exec.execute('e-wrap', { argv: ['echo', 'hello-bg'], run_in_background: true }, wsCtx);
    expect(res.type).toBe('text');
    const id = reg.list()[0]!.taskId;

    await sleep(200);
    const out = await read.execute('r-wrap', { task_id: id }, ctx(reg));
    expect(out.type).toBe('text');
    // 래핑된 argv 가 실제로 실행됐다 — detached 도 jail 을 거쳤다는 증거.
    if (out.type === 'text') expect(out.text).toContain('WRAPPED hello-bg');
  });

  it('refuses background on an isolated session that cannot wrap (no unjailed fallback)', async () => {
    const reg = new InMemoryBackgroundTaskRegistry();
    const exec = createExecTool({ allowList: ['echo'] });

    // gVisor/remote 백엔드의 모양: run() 으로 격리 실행은 하지만 잽 argv 는 못 준다
    // (per-exec 번들·마운트는 {argv, env} 로 표현이 안 된다). 이때 날 spawn 으로
    // 폴백하면 잽 밖 실행이므로, 실행 자체를 거부해야 한다.
    const workspace = {
      root: '/home/agent',
      run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
    };
    const wsCtx = { ...ctx(reg), workspace } as unknown as ToolContext;

    const res = await exec.execute('e-refuse', { argv: ['echo', 'nope'], run_in_background: true }, wsCtx);
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toMatch(/not supported on this sandbox backend/i);
    // 거부는 spawn 이전이어야 한다 — 태스크가 등록조차 되면 안 된다.
    expect(reg.list()).toHaveLength(0);
  });

  it('spawns the wrapped detached process at hostRoot, not the in-jail root', async () => {
    const reg = new InMemoryBackgroundTaskRegistry();
    const exec = createExecTool({ allowList: ['pwd'] });
    const read = createReadTaskOutputTool();

    // whole-jail 백엔드에서 workspace.root 는 in-jail 경로(/home/agent)라 호스트엔 없다.
    // 그 경로를 호스트 spawn 의 cwd 로 쓰면 ENOENT 다 — hostRoot 를 써야 한다.
    const hostRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hostroot-'));
    const workspace = {
      root: '/home/agent',
      hostRoot,
      run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      // 잽 자체는 여기 관심사가 아니라 통과시킨다 — 검증 대상은 호스트측 cwd 선택이다.
      wrapCommand: async (command: { argv: string[]; env?: Record<string, string> }) => ({
        argv: command.argv,
        env: { PATH: process.env.PATH },
      }),
    };
    const wsCtx = { ...ctx(reg), workspace } as unknown as ToolContext;

    const res = await exec.execute('e-hostroot', { argv: ['pwd'], run_in_background: true }, wsCtx);
    expect(res.type).toBe('text');
    const id = reg.list()[0]!.taskId;

    await sleep(300);
    expect(reg.get(id)?.status).toBe('done'); // ENOENT 였다면 'error'
    const out = await read.execute('r-hostroot', { task_id: id }, ctx(reg));
    expect(out.type).toBe('text');
    if (out.type === 'text') expect(out.text).toContain(await fsp.realpath(hostRoot));

    await fsp.rm(hostRoot, { recursive: true, force: true });
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
