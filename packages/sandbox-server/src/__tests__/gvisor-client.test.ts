import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildOciConfig, dropCapabilities, runscRunArgs, GvisorSandboxClient } from '../gvisor-client.js';

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

describe('dropCapabilities', () => {
  it('removes dropped caps from every present set and keeps the rest', () => {
    const caps = {
      bounding: ['CAP_SYS_ADMIN', 'CAP_KILL'],
      effective: ['CAP_SYS_ADMIN', 'CAP_KILL'],
      permitted: ['CAP_SYS_ADMIN', 'CAP_KILL'],
      inheritable: ['CAP_SYS_ADMIN', 'CAP_KILL'],
      // ambient intentionally absent to check the "if present" guard doesn't throw
    };
    dropCapabilities(caps, new Set(['CAP_SYS_ADMIN']));
    expect(caps.bounding).toEqual(['CAP_KILL']);
    expect(caps.effective).toEqual(['CAP_KILL']);
    expect(caps.permitted).toEqual(['CAP_KILL']);
    expect(caps.inheritable).toEqual(['CAP_KILL']);
  });
  it('is a no-op when the drop set does not intersect the caps', () => {
    const caps = { bounding: ['CAP_KILL'], effective: ['CAP_KILL'] };
    dropCapabilities(caps, new Set(['CAP_SYS_ADMIN']));
    expect(caps.bounding).toEqual(['CAP_KILL']);
    expect(caps.effective).toEqual(['CAP_KILL']);
  });
});

describe('GvisorSandboxClient', () => {
  it('create() returns a session rooted at /home/agent with hostRoot=workspace', async () => {
    const convDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gv-'));
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gvbase-'));
    await fsp.mkdir(path.join(base, 'bin'), { recursive: true });
    const client = new GvisorSandboxClient({ convDir, baseRootfsDir: base });
    const s = await client.create({ metadata: { sessionKey: 'k1' } });
    expect(s.root).toBe('/home/agent');
    expect(s.hostRoot).toBe(path.join(convDir, 'k1', 'workspace'));
    const r = await s.resolve('a/b.txt');
    expect(r.path).toBe(path.join(s.hostRoot!, 'a/b.txt'));
  });

  it('resolve() rejects workspace escape', async () => {
    const convDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gv-'));
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gvbase-'));
    const client = new GvisorSandboxClient({ convDir, baseRootfsDir: base });
    const s = await client.create({ metadata: { sessionKey: 'k2' } });
    await expect(s.resolve('../escape')).rejects.toThrow(/escapes workspace/);
  });

  it("constructor throws when network='proxy' without egressSocketPath", async () => {
    const convDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gv-'));
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gvbase-'));
    expect(() => new GvisorSandboxClient({ convDir, baseRootfsDir: base, network: 'proxy' })).toThrow(
      /egressSocketPath/,
    );
  });
});

function findBin(name: string): string | null {
  try {
    return execSync(`command -v ${name}`, { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}
const RUNSC = findBin('runsc');
const BUSYBOX = findBin('busybox');
// Runs only where BOTH runsc and busybox exist (Linux CI / dev box); skips cleanly elsewhere
// (e.g. this macOS host). A missing rootfs binary is the failure mode we must NOT ship, so the
// rootfs is built from a real busybox below rather than an empty dir.
const gated = RUNSC && BUSYBOX ? it : it.skip;

async function buildBusyboxRootfs(dir: string): Promise<void> {
  for (const d of ['bin', 'proc', 'dev', 'sys', 'tmp', 'opt']) {
    await fsp.mkdir(path.join(dir, d), { recursive: true });
  }
  await fsp.copyFile(BUSYBOX!, path.join(dir, 'bin', 'busybox'));
  await fsp.chmod(path.join(dir, 'bin', 'busybox'), 0o755);
  for (const applet of ['sh', 'true', 'cat', 'echo', 'ls', 'head']) {
    await fsp.symlink('busybox', path.join(dir, 'bin', applet));
  }
}

describe('GvisorSandboxClient (runsc integration)', () => {
  gated(
    'selfCheck passes and installs persist across two runs',
    async () => {
      const convDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gv-int-'));
      const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gvbase-int-'));
      await buildBusyboxRootfs(base);
      const client = new GvisorSandboxClient({ convDir, baseRootfsDir: base });
      await client.selfCheck();

      const session = await client.create({ metadata: { sessionKey: 'int-1' } });
      const write = await session.run!({
        argv: ['/bin/sh', '-c', 'echo installed > /opt/marker'],
        timeoutMs: 60_000,
      });
      expect(write.exitCode).toBe(0);

      // A second, independent `runsc run` reads what the first wrote — proves --overlay2=none
      // persists rootfs writes across execs for the session lifetime.
      const read = await session.run!({
        argv: ['/bin/sh', '-c', 'cat /opt/marker'],
        timeoutMs: 60_000,
      });
      expect(read.exitCode).toBe(0);
      expect(read.stdout).toContain('installed');
    },
    120_000,
  );
});
