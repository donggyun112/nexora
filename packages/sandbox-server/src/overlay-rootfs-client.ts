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
  /**
   * 'none' = deny-all (--unshare-net, 기본). 'share' = full egress (host netns).
   * 'proxy' = --unshare-net 유지 + 잽 안 socat 브리지로 host-side allowlist CONNECT
   * 프록시(egressSocketPath)만 통과 — 도메인 allowlist egress. egressSocketPath 필수.
   */
  network?: 'none' | 'share' | 'proxy';
  /** network:'proxy' 일 때 host-side egress 프록시가 listen 하는 유닉스소켓 경로. */
  egressSocketPath?: string;
  /** Toplevel dirs overlaid rw. */
  systemDirs?: string[];
  bwrapPath?: string;
}

const DEFAULT_SYSTEM_DIRS = ['usr', 'etc', 'var', 'opt', 'srv', 'root'];
// merged-usr 심링크 재현 대상 — 호스트에 실제 존재하는 것만 적용된다.
const USR_MERGE_LINKS = ['bin', 'sbin', 'lib', 'lib32', 'lib64', 'libx32'];
// 프로세스 시작 시 1회만 호스트 `/` 를 조회한다 — buildBwrapArgs 를 호출마다
// I/O 없는 순수 함수로 유지하기 위함 (테스트 표면 계약).
const DEFAULT_USR_MERGE_LINKS = USR_MERGE_LINKS.filter((l) => {
  try {
    return existsSync(`/${l}`);
  } catch {
    return false;
  }
});
const SANDBOX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

// 에이전트 작업 HOME 의 in-jail 경로. 호스트 backing(workspaceDir)을 여기로 bind 해
// 에이전트가 호스트 절대경로(/Users/…) 대신 깨끗한 관례 경로를 보게 한다
// (ADR 2026-07-08-agent-world-per-session-rootfs).
const AGENT_HOME = '/home/agent';

// proxy egress: 잽은 --unshare-net 이라 외부 경로가 없다. 잽 안 socat 이
// loopback:PROXY_LISTEN_PORT → bind-mount 된 유닉스소켓(EGRESS_SOCK_IN_JAIL)으로
// 포워딩하고, 호스트측 allowlist CONNECT 프록시가 그 소켓에 listen 한다. 이 경로가
// 유일한 egress 라 container-root 여도 allowlist 밖으로 못 나간다 (allowlist 집행은
// 호스트측 프록시가; 여기선 배관만 깐다). HTTPS_PROXY=http://127.0.0.1:PROXY_LISTEN_PORT
// 는 호출자(buildClaudeEnv 등)가 cmd.env 로 주입한다.
const EGRESS_SOCK_IN_JAIL = '/run/nexora/egress.sock';
const PROXY_LISTEN_PORT = 3128;
const PROXY_URL_IN_JAIL = `http://127.0.0.1:${PROXY_LISTEN_PORT}`;

/**
 * network:'proxy' 일 때 실제 argv 를 감싸는 인너-런처. 잽 안에서 socat 브리지를 띄워
 * 127.0.0.1:PROXY_LISTEN_PORT → 유닉스소켓 포워딩을 세우고, 준비되면 실제 명령("$@")을
 * 실행한다. 명령 종료 시 socat 을 정리한다. `sh -lc <script> <argv0> ...cmd.argv` 형태로
 * 넘겨 "$@" 가 cmd.argv 가 되게 한다. 순수 문자열 — I/O 없음(buildBwrapArgs 계약 유지).
 */
function egressLauncherScript(): string {
  return (
    `socat TCP-LISTEN:${PROXY_LISTEN_PORT},fork,reuseaddr,bind=127.0.0.1 ` +
    `UNIX-CONNECT:${EGRESS_SOCK_IN_JAIL} >/dev/null 2>&1 & _egp=$!; ` +
    `for _i in 1 2 3 4 5 6 7 8 9 10; do ` +
    `socat -u OPEN:/dev/null TCP:127.0.0.1:${PROXY_LISTEN_PORT} >/dev/null 2>&1 && break; ` +
    `sleep 0.1; done; ` +
    `"$@"; _rc=$?; kill $_egp >/dev/null 2>&1; exit $_rc`
  );
}

export function buildBwrapArgs(
  base: {
    convDir: string;
    sessionDir: string;
    workspaceDir: string;
    systemDirs: string[];
    network: 'none' | 'share' | 'proxy';
    egressSocketPath?: string;
    /** Optional session-private home mount used by the agent jail runner. */
    sessionHomeDir?: string;
    /** Task source exposed inside a session home as read-only input. */
    inputDir?: string;
    /** Host worktree root to hide after the selected input has been mounted. */
    workdirRoot?: string;
    /**
     * workspace 를 잽 안에서 마운트할 경로. 기본 AGENT_HOME(/home/agent) — 호스트 backing 경로를
     * 에이전트에 숨긴다(잽 안에서 claude 를 돌리는 whole-jail 모델). 호스트에서 도는
     * 오케스트레이터(예: 훅으로 Bash 만 잽에 보내는 모델)는 잽 안 명령의 경로를 자기 것과
     * 일치시키기 위해 호스트 workdir 경로를 넘긴다(그때 cmd.cwd 도 같은 값). 경로 은닉 이점은
     * 그 모델에선 무의미하므로(오케스트레이터가 이미 호스트 경로를 앎) 안전하다.
     */
    mountPath?: string;
  },
  cmd: { argv: string[]; cwd: string },
  usrMergeLinks: string[] = DEFAULT_USR_MERGE_LINKS,
): string[] {
  // Unshare everything EXCEPT the user namespace. A userns forces bwrap's
  // overlay mounts to use `userxattr`, which the kernel refuses to stack over
  // the container's own `nouserxattr` overlay rootfs (containerd/overlay2) —
  // it fails with "Invalid argument". Running without a userns (as the
  // privileged container root — the trust boundary here) makes the overlay use
  // trusted xattrs, which nest correctly. Isolation still comes from the mount/
  // pid/ipc/uts/cgroup(/net) namespaces + the overlay rootfs + workspace jail.
  const args = ['--ro-bind', '/', '/', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup'];
  if (base.network !== 'share') args.push('--unshare-net');
  args.push('--die-with-parent', '--uid', '0', '--gid', '0');
  for (const dir of base.systemDirs) {
    args.push(
      '--overlay-src', `/${dir}`,
      '--overlay', path.join(base.sessionDir, 'upper', dir), path.join(base.sessionDir, 'work', dir), `/${dir}`,
    );
  }
  for (const link of usrMergeLinks) args.push('--symlink', `usr/${link}`, `/${link}`);
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run');
  // 다른 대화의 upper/workspace 가 lower 로 비치지 않게 conv 볼륨 전체를 가리고, 그 다음에
  // 자기 workspace 를 in-jail 마운트 경로(기본 /home/agent, base.mountPath 로 override)로
  // 되살린다 — bwrap 은 선언 순서 적용; bind 소스는 tmpfs 마스크와 무관하게 호스트에서
  // 해석되므로 마스크 뒤 re-bind 가 성립.
  args.push('--tmpfs', base.convDir);
  // --ro-bind / / makes the root filesystem read-only, so Bubblewrap cannot
  // create the /home/agent bind destination implicitly.
  args.push('--tmpfs', '/home');
  args.push('--dir', AGENT_HOME);
  const sessionHomeMode = base.sessionHomeDir || base.inputDir || base.workdirRoot;
  if (sessionHomeMode) {
    if (!base.sessionHomeDir || !base.inputDir || !base.workdirRoot) {
      throw new Error('buildBwrapArgs: sessionHomeDir, inputDir, and workdirRoot must be supplied together');
    }
    args.push('--bind', base.sessionHomeDir, AGENT_HOME);
    args.push('--ro-bind', base.inputDir, `${AGENT_HOME}/input`);
    // The input source stays available at its host path after --ro-bind / /.
    // Mask the whole task tree only after the selected input has been mounted.
    args.push('--tmpfs', base.workdirRoot);
  } else {
    args.push('--bind', base.workspaceDir, base.mountPath ?? AGENT_HOME);
  }
  if (base.network === 'proxy') {
    // egress 유닉스소켓을 잽에 bind (tmpfs 마스크 뒤 — 소스는 호스트에서 해석되고
    // dest 경로는 bwrap 이 생성) 하고, 실제 명령을 socat 브리지 런처로 감싼다.
    if (!base.egressSocketPath) {
      throw new Error("buildBwrapArgs: network 'proxy' requires base.egressSocketPath");
    }
    args.push('--dir', '/run/nexora', '--bind', base.egressSocketPath, EGRESS_SOCK_IN_JAIL);
    // 잽 실행 자체에 egress 프록시 env 를 박는다(--setenv) — 어떤 spawner(server /exec,
    // jail-run 등)든 잽 안 명령이 자동으로 confined egress 를 쓴다(호출자가 손 안 댐).
    // 대/소문자 둘 다: claude(undici)는 대문자, wget/일부 CLI 는 소문자를 읽는다.
    for (const [k, v] of [
      ['HTTPS_PROXY', PROXY_URL_IN_JAIL],
      ['HTTP_PROXY', PROXY_URL_IN_JAIL],
      ['https_proxy', PROXY_URL_IN_JAIL],
      ['http_proxy', PROXY_URL_IN_JAIL],
      ['NO_PROXY', ''],
      ['no_proxy', ''],
    ] as const) {
      args.push('--setenv', k, v);
    }
    args.push(
      '--chdir', cmd.cwd,
      '--', '/bin/sh', '-lc', egressLauncherScript(), 'nexora-egress', ...cmd.argv,
    );
  } else {
    args.push('--chdir', cmd.cwd, '--', ...cmd.argv);
  }
  return args;
}

export class OverlayRootfsSandboxClient implements SandboxClient {
  private readonly convDir: string;
  private readonly network: 'none' | 'share' | 'proxy';
  private readonly egressSocketPath?: string;
  private readonly systemDirs: string[];
  private readonly bwrapPath: string;

  constructor(options: OverlayRootfsOptions) {
    this.convDir = path.resolve(options.convDir);
    this.network = options.network ?? 'none';
    this.egressSocketPath = options.egressSocketPath;
    if (this.network === 'proxy' && !this.egressSocketPath) {
      throw new Error("OverlayRootfsSandboxClient: network 'proxy' requires egressSocketPath");
    }
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
    const dir = path.join(this.convDir, encodeURIComponent(key));
    const relative = path.relative(this.convDir, dir);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`sessionKey escapes convDir: ${key}`);
    }
    return dir;
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
      egressSocketPath: this.egressSocketPath,
    };
    const bwrapPath = this.bwrapPath;
    // 에이전트가 보는 논리 root 는 /home/agent(AGENT_HOME); 호스트 backing 은 workspaceDir.
    // fs-wire(서버 host-side fsp)는 backing 을 읽어야 하므로 resolve 가 in-jail 경로를
    // backing 으로 되돌린다. (server 의 persist(writeTar(root))·exec-cwd 정합은 Task 2 에서
    // root vs host-backing 을 분리해 처리한다.)
    const toHostRel = (rel: string): string =>
      rel === AGENT_HOME ? '.' : rel.startsWith(AGENT_HOME + '/') ? rel.slice(AGENT_HOME.length + 1) : rel;
    return {
      id: key,
      root: AGENT_HOME,
      hostRoot: workspaceDir,
      mode: 'workspace-write',
      mounts: [],
      async resolve(rel: string, options?: WorkspaceResolveOptions): Promise<ResolvedWorkspacePath> {
        const joined = path.resolve(workspaceDir, toHostRel(rel));
        const relative = path.relative(workspaceDir, joined);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(`path escapes workspace: ${rel}`);
        }
        const write = options?.access === 'write' || options?.access === 'readwrite';
        return {
          path: joined,
          root: AGENT_HOME,
          relativePath: relative === '' ? '.' : relative,
          access: write ? 'rw' : 'ro',
        };
      },
      async run(cmd: SandboxCommand): Promise<SandboxCommandResult> {
        const cwd = cmd.cwd ?? AGENT_HOME;
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
      cmd.signal?.removeEventListener('abort', onAbort);
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
