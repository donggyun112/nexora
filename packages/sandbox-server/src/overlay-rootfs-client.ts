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
import { spawnCollect } from './exec-collect.js';
import {
  EGRESS_SOCK_IN_JAIL,
  GW_BASE_URL_IN_JAIL,
  GW_LISTEN_PORT,
  GW_SOCK_IN_JAIL,
  loopbackBridgeScript,
  PROXY_LISTEN_PORT,
  PROXY_URL_IN_JAIL,
  type LoopbackBridge,
} from './socat-bridge.js';

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
  /**
   * Capabilities dropped from the in-jail process (bwrap `--cap-drop`). Defaults to
   * {@link DEFAULT_CAP_DROPS} — the escape-relevant caps, keeping the ones apt/dpkg need.
   * Pass `['ALL']` to drop everything, or `[]` to disable dropping (legacy full-root).
   */
  capDrops?: readonly string[];
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

// 잽 안 프로세스는 uid 0 으로 돈다(userns 없음 — Colima/overlay userxattr 제약, 위 참조).
// userns 를 포기해도 capability 는 독립적으로 떨굴 수 있다: 아래는 컨테이너 탈출·호스트
// 접근에 쓰이는 caps 만 정밀 드롭한다. pip/apt postinst 가 필요로 하는 CHOWN/DAC_OVERRIDE/
// FOWNER/FSETID/SETUID/SETGID/SETPCAP/SETFCAP/KILL 은 남긴다(overlay 로 /usr·/var RW 유지가
// 목적이므로). 더 조이려면 capDrops 를 ['ALL'] 로 주고 필요한 것만 환경에서 되돌리면 된다.
//  - SYS_ADMIN: mount/namespace 조작   - MKNOD: device node → raw disk 읽기
//  - DAC_READ_SEARCH: open_by_handle_at (Shocker 류 탈출)
//  - SYS_MODULE/SYS_RAWIO/SYS_PTRACE/SYS_BOOT/SYS_TIME/SYSLOG: 커널 표면
//  - NET_ADMIN/NET_RAW: (net 은 이미 unshare 되지만 방어적으로)
const DEFAULT_CAP_DROPS: readonly string[] = [
  'CAP_SYS_ADMIN',
  'CAP_MKNOD',
  'CAP_DAC_READ_SEARCH',
  'CAP_SYS_MODULE',
  'CAP_SYS_RAWIO',
  'CAP_SYS_PTRACE',
  'CAP_SYS_BOOT',
  'CAP_SYS_TIME',
  'CAP_SYSLOG',
  'CAP_NET_ADMIN',
  'CAP_NET_RAW',
];

// 에이전트 작업 HOME 의 in-jail 경로. 호스트 backing(workspaceDir)을 여기로 bind 해
// 에이전트가 호스트 절대경로(/Users/…) 대신 깨끗한 관례 경로를 보게 한다
// (ADR 2026-07-08-agent-world-per-session-rootfs).
const AGENT_HOME = '/home/agent';

// proxy egress 상수·loopbackBridgeScript 는 bwrap/gVisor 공유 모듈 socat-bridge.ts 로
// 이전됨 — 위 import 참조.

export function buildBwrapArgs(
  base: {
    convDir: string;
    sessionDir: string;
    workspaceDir: string;
    systemDirs: string[];
    network: 'none' | 'share' | 'proxy';
    egressSocketPath?: string;
    /** Per-conversation auth-injecting gateway unix socket. When set (network 'proxy'),
     *  the jail reaches it at GW_SOCK_IN_JAIL via a loopback bridge and ANTHROPIC_BASE_URL. */
    authGatewaySocketPath?: string;
    /**
     * Capabilities to drop from the jailed process. Undefined → {@link DEFAULT_CAP_DROPS};
     * `[]` → drop nothing (legacy full-root); `['ALL']` → drop every capability.
     */
    capDrops?: readonly string[];
    /** Optional session-private home mount used by the agent jail runner. */
    sessionHomeDir?: string;
    /** Task source exposed inside a session home as read-only input. */
    inputDir?: string;
    /** Host worktree root to hide after the selected input has been mounted. */
    workdirRoot?: string;
    /** Trusted host directories exposed in the jail at read-only destinations. */
    readOnlyMounts?: ReadonlyArray<{ source: string; destination: string }>;
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
  // Drop escape-relevant capabilities even though we run as uid 0 without a userns
  // (cap-drop is independent of the userns decision). Order before the overlay/bind
  // mounts is irrelevant to bwrap; kept here next to uid/gid for readability.
  for (const cap of base.capDrops ?? DEFAULT_CAP_DROPS) args.push('--cap-drop', cap);
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
  args.push('--tmpfs', '/mnt');
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
  for (const mount of base.readOnlyMounts ?? []) {
    if (!path.posix.isAbsolute(mount.source) || !path.posix.isAbsolute(mount.destination)) {
      throw new Error('buildBwrapArgs: readOnlyMounts require absolute source and destination paths');
    }
    args.push('--dir', path.posix.dirname(mount.destination));
    args.push('--dir', mount.destination);
    args.push('--ro-bind', mount.source, mount.destination);
  }
  if (base.network === 'proxy') {
    // egress 유닉스소켓을 잽에 bind (tmpfs 마스크 뒤 — 소스는 호스트에서 해석되고
    // dest 경로는 bwrap 이 생성) 하고, 실제 명령을 socat 브리지 런처로 감싼다.
    if (!base.egressSocketPath) {
      throw new Error("buildBwrapArgs: network 'proxy' requires base.egressSocketPath");
    }
    args.push('--dir', '/run/nexora', '--bind', base.egressSocketPath, EGRESS_SOCK_IN_JAIL);
    const bridges: LoopbackBridge[] = [{ listenPort: PROXY_LISTEN_PORT, socketInJail: EGRESS_SOCK_IN_JAIL }];
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
    if (base.authGatewaySocketPath) {
      args.push('--bind', base.authGatewaySocketPath, GW_SOCK_IN_JAIL);
      args.push('--setenv', 'ANTHROPIC_BASE_URL', GW_BASE_URL_IN_JAIL);
      // The default NO_PROXY '' above (undici honors HTTP_PROXY) would otherwise route the
      // gateway loopback request THROUGH the egress CONNECT proxy, which only allowlists
      // egress domains and rejects it. Override (bwrap keeps the LAST --setenv per name) so
      // loopback bypasses the egress proxy — 127.0.0.1 in this netns is only the jail's own
      // socat bridges, never real egress, so this doesn't weaken egress confinement.
      args.push('--setenv', 'NO_PROXY', '127.0.0.1,localhost');
      args.push('--setenv', 'no_proxy', '127.0.0.1,localhost');
      bridges.push({ listenPort: GW_LISTEN_PORT, socketInJail: GW_SOCK_IN_JAIL });
    }
    args.push(
      '--chdir', cmd.cwd,
      '--', '/bin/sh', '-lc', loopbackBridgeScript(bridges), 'nexora-egress', ...cmd.argv,
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
  private readonly capDrops: readonly string[];
  private readonly bwrapPath: string;

  constructor(options: OverlayRootfsOptions) {
    this.convDir = path.resolve(options.convDir);
    this.network = options.network ?? 'none';
    this.egressSocketPath = options.egressSocketPath;
    if (this.network === 'proxy' && !this.egressSocketPath) {
      throw new Error("OverlayRootfsSandboxClient: network 'proxy' requires egressSocketPath");
    }
    this.systemDirs = options.systemDirs ?? DEFAULT_SYSTEM_DIRS;
    this.capDrops = options.capDrops ?? DEFAULT_CAP_DROPS;
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
      capDrops: this.capDrops,
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
