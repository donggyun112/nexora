import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildOciConfig, dropCapabilities, runscRunArgs, GvisorSandboxClient } from '../gvisor-client.js';
import { startEgressProxy } from '../egress-proxy.js';

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

describe('buildOciConfig (network proxy)', () => {
  it('proxy+gw: binds egress/gw sockets rw, wraps args in socat bridge, injects proxy+gateway env', () => {
    const c = buildOciConfig(
      { sessionRootfsDir: '/r', workspaceDir: '/w', network: 'proxy',
        egressSocketPath: '/run/egress.sock', authGatewaySocketPath: '/run/gw.sock' },
      { argv: ['claude', '-p'], cwd: '/home/agent' });
    expect(c.mounts.find((m: any) => m.destination === '/run/nexora/egress.sock'))
      .toMatchObject({ source: '/run/egress.sock', type: 'bind', options: ['rbind', 'rw'] });
    expect(c.mounts.find((m: any) => m.destination === '/run/nexora/gateway.sock'))
      .toMatchObject({ source: '/run/gw.sock', type: 'bind', options: ['rbind', 'rw'] });
    expect(c.process.args[0]).toBe('/bin/sh'); // socat bridge launcher wraps the real cmd
    for (const e of [
      'HTTPS_PROXY=http://127.0.0.1:3128', 'HTTP_PROXY=http://127.0.0.1:3128',
      'https_proxy=http://127.0.0.1:3128', 'http_proxy=http://127.0.0.1:3128',
      'ANTHROPIC_BASE_URL=http://127.0.0.1:3129',
      'NO_PROXY=127.0.0.1,localhost', 'no_proxy=127.0.0.1,localhost',
    ]) {
      expect(c.process.env).toContain(e);
    }
  });

  it('proxy without gw: egress only, NO_PROXY empty (matches bwrap default)', () => {
    const c = buildOciConfig(
      { sessionRootfsDir: '/r', workspaceDir: '/w', network: 'proxy', egressSocketPath: '/run/egress.sock' },
      { argv: ['x'], cwd: '/home/agent' });
    expect(c.mounts.find((m: any) => m.destination === '/run/nexora/gateway.sock')).toBeUndefined();
    expect(c.process.env).toContain('HTTPS_PROXY=http://127.0.0.1:3128');
    expect(c.process.env).toContain('NO_PROXY=');
    expect(c.process.env.some((e: string) => e.startsWith('ANTHROPIC_BASE_URL='))).toBe(false);
  });

  it('proxy: throws when egressSocketPath is missing', () => {
    expect(() =>
      buildOciConfig(
        { sessionRootfsDir: '/r', workspaceDir: '/w', network: 'proxy' },
        { argv: ['x'], cwd: '/home/agent' },
      ),
    ).toThrow(/egressSocketPath/);
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
const SOCAT = findBin('socat');
// Runs only where runsc, busybox, AND socat all exist (Linux CI / dev box); skips cleanly
// elsewhere (e.g. this macOS host). socat is required in addition to the base gate because
// network:'proxy' wraps the command in the in-jail loopback bridge launcher (socat-bridge.ts),
// which needs a real `socat` binary reachable inside the jailed rootfs.
const gated = RUNSC && BUSYBOX ? it : it.skip;
const gatedProxy = RUNSC && BUSYBOX && SOCAT ? it : it.skip;

async function buildBusyboxRootfs(dir: string): Promise<void> {
  for (const d of ['bin', 'proc', 'dev', 'sys', 'tmp', 'opt', 'run', 'run/nexora']) {
    await fsp.mkdir(path.join(dir, d), { recursive: true });
  }
  await fsp.copyFile(BUSYBOX!, path.join(dir, 'bin', 'busybox'));
  await fsp.chmod(path.join(dir, 'bin', 'busybox'), 0o755);
  for (const applet of ['sh', 'true', 'cat', 'echo', 'ls', 'head']) {
    await fsp.symlink('busybox', path.join(dir, 'bin', applet));
  }
  if (SOCAT) {
    await fsp.copyFile(SOCAT, path.join(dir, 'bin', 'socat'));
    await fsp.chmod(path.join(dir, 'bin', 'socat'), 0o755);
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

describe('GvisorSandboxClient (runsc integration, network proxy)', () => {
  // bwrap 백엔드(overlay-rootfs-client.test.ts)조차 network:'proxy' 를 실 프로세스로 끝까지
  // 태우는 라이브 egress 테스트는 없다 — buildBwrapArgs 순수 단위 테스트만 있다. 여기서도
  // 같은 선을 따른다: 실 runsc + 실 egress 유닉스소켓 + 실 socat 브릿지로 부팅/실행이 되는지를
  // 검증하되(브리지가 안 뜨면 selfCheck/run 자체가 실패한다), 외부 네트워크/DNS 의존적인
  // "허용 도메인으로 실제 아웃바운드가 통과하는지" 왕복까지는 확인하지 않는다.
  gatedProxy(
    'network=proxy boots: host-uds bind-mount + socat bridge start, real egress socket reachable',
    async () => {
      const convDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gv-proxy-int-'));
      const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gvbase-proxy-int-'));
      await buildBusyboxRootfs(base);

      const proxySocketDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gv-egress-sock-'));
      const egressSocketPath = path.join(proxySocketDir, 'egress.sock');
      const proxy = await startEgressProxy({ socketPath: egressSocketPath, allowedDomains: ['example.com'] });
      try {
        const client = new GvisorSandboxClient({
          convDir,
          baseRootfsDir: base,
          network: 'proxy',
          egressSocketPath: proxy.socketPath,
        });
        // selfCheck() runs /bin/true wrapped in the socat bridge launcher — this exercises
        // --host-uds=open, the egress socket bind-mount, socat listen+poll-until-ready, and
        // clean bridge teardown end to end under a real runsc jail.
        await client.selfCheck();

        const session = await client.create({ metadata: { sessionKey: 'proxy-int-1' } });
        // The bridge script bind-mounts the egress socket at EGRESS_SOCK_IN_JAIL — confirm the
        // jailed process actually sees it at that exact path (proves the mount landed correctly,
        // independent of whether the bridge's own readiness poll happened to succeed).
        const check = await session.run!({
          argv: ['/bin/sh', '-c', 'test -S /run/nexora/egress.sock && echo SOCK_OK'],
          timeoutMs: 60_000,
        });
        expect(check.exitCode).toBe(0);
        expect(check.stdout).toContain('SOCK_OK');
      } finally {
        await proxy.close();
      }
    },
    120_000,
  );
});
