import { describe, it, expect } from 'vitest';
import { buildOciConfig, runscRunArgs } from '../gvisor-client.js';

const base = { sessionRootfsDir: '/conv/s1/rootfs', workspaceDir: '/conv/s1/workspace', network: 'none' as const };

describe('buildOciConfig (network none)', () => {
  it('roots at the session rootfs, writable', () => {
    const c = buildOciConfig(base, { argv: ['/bin/echo', 'hi'], cwd: '/home/agent' });
    expect(c.root).toEqual({ path: '/conv/s1/rootfs', readonly: false });
  });
  it('bind-mounts the workspace at /home/agent rw', () => {
    const c = buildOciConfig(base, { argv: ['x'], cwd: '/home/agent' });
    const m = c.mounts.find((m: any) => m.destination === '/home/agent');
    expect(m).toMatchObject({ source: '/conv/s1/workspace', type: 'bind', options: ['rbind', 'rw'] });
  });
  it('sets args, cwd, terminal=false, and PATH/HOME env', () => {
    const c = buildOciConfig(base, { argv: ['/bin/sh', '-c', 'true'], cwd: '/home/agent/x' });
    expect(c.process.args).toEqual(['/bin/sh', '-c', 'true']);
    expect(c.process.cwd).toBe('/home/agent/x');
    expect(c.process.terminal).toBe(false);
    expect(c.process.env).toContain('HOME=/home/agent');
    expect(c.process.env.some((e: string) => e.startsWith('PATH='))).toBe(true);
  });
  it('drops escape-relevant capabilities', () => {
    const c = buildOciConfig(base, { argv: ['x'], cwd: '/' });
    const all = [...c.process.capabilities.bounding, ...c.process.capabilities.effective];
    expect(all).not.toContain('CAP_SYS_ADMIN');
    expect(all).not.toContain('CAP_SYS_PTRACE');
  });
  it('does not mutate the shared base template between calls', () => {
    const a = buildOciConfig(base, { argv: ['a'], cwd: '/' });
    const b = buildOciConfig(base, { argv: ['b'], cwd: '/' });
    expect(a.process.args).toEqual(['a']);
    expect(b.process.args).toEqual(['b']);
  });
});

describe('runscRunArgs', () => {
  it('systrap + no-KVM flags, bundle+id, host-uds only when requested', () => {
    expect(runscRunArgs('/b', 'id1', { hostUds: false })).toEqual([
      '--platform=systrap', '--network=none', '--overlay2=none', '--ignore-cgroups', 'run', '-bundle', '/b', 'id1',
    ]);
    expect(runscRunArgs('/b', 'id1', { hostUds: true })).toContain('--host-uds=open');
  });
});
