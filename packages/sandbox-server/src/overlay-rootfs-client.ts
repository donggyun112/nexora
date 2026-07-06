/**
 * OverlayRootfsSandboxClient — 대화별 rootfs backend.
 *
 * 세션 = "컨테이너 자신의 rootfs(RO lower) + 대화별 upperdir(RW)" 를 bwrap
 * --overlay 로 조립한 사적 rootfs. pip/apt 설치물은 upper 에 남아 대화 수명
 * 동안 유지된다. workspace 는 overlay 밖 host-visible 디렉토리라 fs wire·
 * seedDirs·resolve 가 ASRT backend 와 동일하게 동작한다 (동일-경로 bind).
 *
 * cleanup() 은 no-op 이다 — 디스크 상태가 곧 archive 이며 삭제는 store 소관.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  ResolvedWorkspacePath,
  SandboxClient,
  SandboxCommand,
  SandboxCommandResult,
  WorkspaceAcquireOptions,
  WorkspaceResolveOptions,
  WorkspaceSession,
} from '@dongkseo/contracts';

export interface OverlayRootfsOptions {
  /** Volume-backed dir holding per-session rootfs state. MUST NOT be on overlayfs. */
  convDir: string;
  /** 'share' = full egress (host netns). Default deny-all. */
  network?: 'none' | 'share';
  /** Toplevel dirs overlaid rw. */
  systemDirs?: string[];
  bwrapPath?: string;
}

const DEFAULT_SYSTEM_DIRS = ['usr', 'etc', 'var', 'opt', 'srv', 'root'];
// merged-usr 심링크 재현 대상 — 호스트에 실제 존재하는 것만 적용된다.
const USR_MERGE_LINKS = ['bin', 'sbin', 'lib', 'lib32', 'lib64', 'libx32'];
const SANDBOX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export function buildBwrapArgs(
  base: { convDir: string; sessionDir: string; workspaceDir: string; systemDirs: string[]; network: 'none' | 'share' },
  cmd: { argv: string[]; cwd: string },
  usrMergeLinks: string[] = USR_MERGE_LINKS.filter((l) => {
    try {
      return existsSync(`/${l}`);
    } catch {
      return false;
    }
  }),
): string[] {
  const args = ['--unshare-all'];
  if (base.network === 'share') args.push('--share-net');
  args.push('--die-with-parent', '--uid', '0', '--gid', '0');
  for (const dir of base.systemDirs) {
    args.push(
      '--overlay-src', `/${dir}`,
      '--overlay', path.join(base.sessionDir, 'upper', dir), path.join(base.sessionDir, 'work', dir), `/${dir}`,
    );
  }
  for (const link of usrMergeLinks) args.push('--symlink', `usr/${link}`, `/${link}`);
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  // 다른 대화의 upper/workspace 가 lower 로 비치지 않게 conv 볼륨 전체를 가리고,
  // 그 다음에 자기 workspace 만 동일 경로로 되살린다 (bwrap 은 선언 순서 적용).
  args.push('--tmpfs', base.convDir);
  args.push('--bind', base.workspaceDir, base.workspaceDir);
  args.push('--chdir', cmd.cwd, '--', ...cmd.argv);
  return args;
}

export class OverlayRootfsSandboxClient implements SandboxClient {
  private readonly convDir: string;
  private readonly network: 'none' | 'share';
  private readonly systemDirs: string[];
  private readonly bwrapPath: string;

  constructor(options: OverlayRootfsOptions) {
    this.convDir = path.resolve(options.convDir);
    this.network = options.network ?? 'none';
    this.systemDirs = options.systemDirs ?? DEFAULT_SYSTEM_DIRS;
    this.bwrapPath = options.bwrapPath ?? 'bwrap';
  }

  async create(options: WorkspaceAcquireOptions = {}): Promise<WorkspaceSession> {
    const key = typeof options.metadata?.sessionKey === 'string' ? options.metadata.sessionKey : crypto.randomUUID();
    const sessionDir = this.sessionDir(key);
    const workspaceDir = path.join(sessionDir, 'workspace');
    await fsp.mkdir(workspaceDir, { recursive: true, mode: 0o700 });
    for (const dir of this.systemDirs) {
      await fsp.mkdir(path.join(sessionDir, 'upper', dir), { recursive: true });
      await fsp.mkdir(path.join(sessionDir, 'work', dir), { recursive: true });
    }
    await this.touchMeta(sessionDir);
    await seedInto(workspaceDir, options.seedDirs);
    return this.makeSession(key, sessionDir, workspaceDir);
  }

  /** 기존 conv 디렉토리로 세션 핸들을 재구성한다 (thaw 용). 없으면 null. */
  async attach(key: string): Promise<WorkspaceSession | null> {
    const sessionDir = this.sessionDir(key);
    const workspaceDir = path.join(sessionDir, 'workspace');
    try {
      const stat = await fsp.stat(workspaceDir);
      if (!stat.isDirectory()) return null;
    } catch {
      return null;
    }
    await this.touchMeta(sessionDir);
    return this.makeSession(key, sessionDir, workspaceDir);
  }

  /** 디스크가 곧 archive — 삭제는 ArchiveStore.delete 소관이라 여기선 no-op. */
  async delete(_session: WorkspaceSession): Promise<void> {}

  /** 부팅 검증: 실제 overlay exec 1회. 실패 시 throw (fail-fast 게이트용). */
  async selfCheck(): Promise<void> {
    const key = `selfcheck-${crypto.randomUUID()}`;
    const session = await this.create({ metadata: { sessionKey: key } });
    try {
      const result = await session.run!({ argv: ['/usr/bin/true'], timeoutMs: 15_000 });
      if (result.exitCode !== 0) {
        throw new Error(`bwrap overlay self-check failed (exit=${result.exitCode}): ${result.stderr}`);
      }
    } finally {
      await fsp.rm(this.sessionDir(key), { recursive: true, force: true });
    }
  }

  private sessionDir(key: string): string {
    return path.join(this.convDir, encodeURIComponent(key));
  }

  private async touchMeta(sessionDir: string): Promise<void> {
    const meta = JSON.stringify({ lastUsedAt: Date.now() });
    await fsp.writeFile(path.join(sessionDir, 'meta.json'), meta).catch(() => {});
  }

  private makeSession(key: string, sessionDir: string, workspaceDir: string): WorkspaceSession {
    const base = {
      convDir: this.convDir,
      sessionDir,
      workspaceDir,
      systemDirs: this.systemDirs,
      network: this.network,
    };
    const bwrapPath = this.bwrapPath;
    return {
      id: key,
      root: workspaceDir,
      mode: 'workspace-write',
      mounts: [],
      async resolve(rel: string, options?: WorkspaceResolveOptions): Promise<ResolvedWorkspacePath> {
        const joined = path.resolve(workspaceDir, rel);
        const relative = path.relative(workspaceDir, joined);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(`path escapes workspace: ${rel}`);
        }
        const write = options?.access === 'write' || options?.access === 'readwrite';
        return {
          path: joined,
          root: workspaceDir,
          relativePath: relative === '' ? '.' : relative,
          access: write ? 'rw' : 'ro',
        };
      },
      async run(cmd: SandboxCommand): Promise<SandboxCommandResult> {
        const cwd = cmd.cwd ?? workspaceDir;
        const args = buildBwrapArgs(base, { argv: cmd.argv, cwd });
        return await spawnCollect(bwrapPath, args, cmd);
      },
      async cleanup(): Promise<void> {},
    };
  }
}

async function spawnCollect(bin: string, args: string[], cmd: SandboxCommand): Promise<SandboxCommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(bin, args, {
      env: { PATH: SANDBOX_PATH, HOME: '/root', ...cmd.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const timer = cmd.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, cmd.timeoutMs)
      : undefined;
    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGKILL');
    };
    cmd.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: null, signal: null, stdout, stderr: `${stderr}\n${String(err)}`.trim() });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      cmd.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        ...(timedOut ? { timedOut: true } : {}),
        ...(aborted ? { aborted: true } : {}),
      });
    });
  });
}

/** seedDirs 를 workspace 안으로 best-effort 복사 (심링크 제외 — root-jail 보호). */
async function seedInto(
  workspaceDir: string,
  seedDirs?: ReadonlyArray<{ source: string; destSubpath: string }>,
): Promise<void> {
  for (const { source, destSubpath } of seedDirs ?? []) {
    const dest = path.resolve(workspaceDir, destSubpath);
    const relative = path.relative(workspaceDir, dest);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    try {
      await fsp.cp(source, dest, {
        recursive: true,
        force: true,
        filter: async (src) => !(await fsp.lstat(src)).isSymbolicLink(),
      });
    } catch {
      // best-effort: 소스 부재/복사 실패는 acquire 를 실패시키지 않는다.
    }
  }
}
