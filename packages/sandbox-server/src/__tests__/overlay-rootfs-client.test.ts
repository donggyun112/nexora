import { getEventListeners } from 'node:events';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OverlayRootfsSandboxClient, buildBwrapArgs } from '../overlay-rootfs-client.js';

const tmpDirs: string[] = [];
async function tmpConvDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'conv-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});

describe('buildBwrapArgs', () => {
  const base = {
    convDir: '/vol/conv',
    sessionDir: '/vol/conv/abc',
    workspaceDir: '/vol/conv/abc/workspace',
    systemDirs: ['usr', 'etc'],
    network: 'none' as const,
  };
  const cmd = { argv: ['python3', '-V'], cwd: '/vol/conv/abc/workspace' };

  it('systemDir 마다 overlay-src/overlay 3쌍을 조립한다', () => {
    const args = buildBwrapArgs(base, cmd);
    const s = args.join(' ');
    expect(s).toContain('--overlay-src /usr --overlay /vol/conv/abc/upper/usr /vol/conv/abc/work/usr /usr');
    expect(s).toContain('--overlay-src /etc --overlay /vol/conv/abc/upper/etc /vol/conv/abc/work/etc /etc');
  });

  it('conv 볼륨 마스킹이 자기 workspace bind 보다 먼저 온다 (다른 대화 차단 + 자기 것 복구)', () => {
    const args = buildBwrapArgs(base, cmd);
    const mask = args.indexOf('/vol/conv');
    const bind = args.indexOf('--bind');
    expect(args[mask - 1]).toBe('--tmpfs');
    expect(mask).toBeGreaterThan(-1);
    expect(bind).toBeGreaterThan(mask);
    expect(args.slice(bind, bind + 3)).toEqual(['--bind', '/vol/conv/abc/workspace', '/vol/conv/abc/workspace']);
  });

  it('network none 은 --unshare-all 만, share 는 --share-net 추가', () => {
    expect(buildBwrapArgs(base, cmd)).toContain('--unshare-all');
    expect(buildBwrapArgs(base, cmd)).not.toContain('--share-net');
    expect(buildBwrapArgs({ ...base, network: 'share' }, cmd)).toContain('--share-net');
  });

  it('argv 는 -- 뒤에 그대로, chdir 은 cwd', () => {
    const args = buildBwrapArgs(base, cmd);
    expect(args.slice(args.indexOf('--') + 1)).toEqual(['python3', '-V']);
    expect(args[args.indexOf('--chdir') + 1]).toBe('/vol/conv/abc/workspace');
  });

  it('usrMergeLinks 를 명시하면 결정적으로 --symlink 쌍을 만든다 (호스트 무관)', () => {
    const args = buildBwrapArgs(base, cmd, ['bin', 'lib']);
    const s = args.join(' ');
    expect(s).toContain('--symlink usr/bin /bin');
    expect(s).toContain('--symlink usr/lib /lib');
    // 결정적 — 같은 입력이면 항상 같은 출력, 호스트 filesystem 조회 없음.
    expect(buildBwrapArgs(base, cmd, ['bin', 'lib'])).toEqual(args);
  });
});

describe('OverlayRootfsSandboxClient (레이아웃 — bwrap 불필요)', () => {
  it('create 는 sessionKey 로 workspace/upper/work 레이아웃을 만든다', async () => {
    const convDir = await tmpConvDir();
    const client = new OverlayRootfsSandboxClient({ convDir, systemDirs: ['usr'] });
    const session = await client.create({ metadata: { sessionKey: 'k1' } });
    expect(session.root).toBe(path.join(convDir, 'k1', 'workspace'));
    await expect(fsp.stat(path.join(convDir, 'k1', 'upper', 'usr'))).resolves.toBeTruthy();
    await expect(fsp.stat(path.join(convDir, 'k1', 'work', 'usr'))).resolves.toBeTruthy();
  });

  it('resolve 는 workspace 를 탈출하면 거부한다', async () => {
    const convDir = await tmpConvDir();
    const client = new OverlayRootfsSandboxClient({ convDir });
    const session = await client.create({ metadata: { sessionKey: 'k2' } });
    await expect(session.resolve('../k-other/secret')).rejects.toThrow();
    const ok = await session.resolve('sub/file.txt');
    expect(ok.path).toBe(path.join(convDir, 'k2', 'workspace', 'sub', 'file.txt'));
  });

  it('create 는 sessionKey 가 convDir 을 탈출하면 거부한다 (path traversal)', async () => {
    const convDir = await tmpConvDir();
    const client = new OverlayRootfsSandboxClient({ convDir });
    await expect(client.create({ metadata: { sessionKey: '..' } })).rejects.toThrow();
    // 정상 키는 여전히 동작한다.
    const session = await client.create({ metadata: { sessionKey: 'normal-key' } });
    expect(session.root).toBe(path.join(convDir, 'normal-key', 'workspace'));
  });

  it('attach 는 기존 디렉토리에 핸들을 재구성하고, 없으면 null', async () => {
    const convDir = await tmpConvDir();
    const client = new OverlayRootfsSandboxClient({ convDir });
    await client.create({ metadata: { sessionKey: 'k3' } });
    const again = await client.attach('k3');
    expect(again?.root).toBe(path.join(convDir, 'k3', 'workspace'));
    expect(await client.attach('nope')).toBeNull();
  });

  it('spawn 오류 시 abort 리스너를 해제해 시그널 재사용시 누수를 막는다', async () => {
    const convDir = await tmpConvDir();
    const client = new OverlayRootfsSandboxClient({
      convDir,
      bwrapPath: path.join(convDir, 'does-not-exist-bwrap'),
    });
    const session = await client.create({ metadata: { sessionKey: 'errkey' } });
    const controller = new AbortController();
    const result = await session.run!({ argv: ['true'], signal: controller.signal });
    expect(result.exitCode).toBeNull();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('seedDirs 를 workspace 안으로 복사한다 (fresh create)', async () => {
    const convDir = await tmpConvDir();
    const src = await tmpConvDir();
    await fsp.writeFile(path.join(src, 'SKILL.md'), 'hi');
    const client = new OverlayRootfsSandboxClient({ convDir });
    const session = await client.create({
      metadata: { sessionKey: 'k4' },
      seedDirs: [{ source: src, destSubpath: '.skill_refs/demo' }],
    });
    const seeded = await fsp.readFile(path.join(session.root, '.skill_refs/demo/SKILL.md'), 'utf8');
    expect(seeded).toBe('hi');
  });
});

const HAVE_BWRAP =
  process.platform === 'linux' && ['/usr/bin/bwrap', '/usr/local/bin/bwrap'].some((p) => existsSync(p));

describe.skipIf(!HAVE_BWRAP)('OverlayRootfsSandboxClient (실 bwrap — Linux 전용)', () => {
  it('overlay 에 쓴 파일이 upper 에 남고 재-exec 에서 보인다', async () => {
    const convDir = await tmpConvDir();
    const client = new OverlayRootfsSandboxClient({ convDir, systemDirs: ['usr'] });
    const session = await client.create({ metadata: { sessionKey: 'live' } });
    const w = await session.run!({ argv: ['/usr/bin/touch', '/usr/PROOF'], timeoutMs: 30_000 });
    expect(w.exitCode).toBe(0);
    await expect(fsp.stat(path.join(convDir, 'live', 'upper', 'usr', 'PROOF'))).resolves.toBeTruthy();
    const r = await session.run!({ argv: ['/usr/bin/test', '-f', '/usr/PROOF'], timeoutMs: 30_000 });
    expect(r.exitCode).toBe(0);
  });
});
