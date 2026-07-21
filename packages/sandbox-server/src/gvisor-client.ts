import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ResolvedWorkspacePath,
  SandboxClient,
  SandboxCommand,
  SandboxCommandResult,
  WorkspaceAcquireOptions,
  WorkspaceResolveOptions,
  WorkspaceSession,
} from '@dongkseo/contracts';
import { SANDBOX_PATH, spawnCollect } from './exec-collect.js';
import ociBase from './oci-base.js';
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

const AGENT_HOME = '/home/agent';
// bwrap 백엔드와 동일한 탈출-관련 cap 세트 (overlay-rootfs-client.ts DEFAULT_CAP_DROPS 미러)
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

const execFileP = promisify(execFile);

/** host overlayfs mount: lower(RO base) + 세션 upper/work → merged. privileged + `mount` 필요. */
async function mountOverlay(lower: string, upper: string, work: string, merged: string): Promise<void> {
  await execFileP('mount', [
    '-t',
    'overlay',
    'overlay',
    '-o',
    `lowerdir=${lower},upperdir=${upper},workdir=${work}`,
    merged,
  ]);
}

/** best-effort umount (실패 시 lazy) — merged 정리 전에 호출. */
async function umountQuiet(target: string): Promise<void> {
  try {
    await execFileP('umount', [target]);
  } catch {
    await execFileP('umount', ['-l', target]).catch(() => {});
  }
}

export interface GvisorSpecBase {
  sessionRootfsDir: string;
  workspaceDir: string;
  network: 'none' | 'proxy';
  egressSocketPath?: string;
  authGatewaySocketPath?: string;
  capDrops?: readonly string[];
}

// OciConfig는 우리가 건드리는 필드만 느슨히 타입핑; 전체는 oci-base.ts 구조.
type OciConfig = Record<string, any>;

/**
 * Removes every capability in `drops` from each present capability set
 * (bounding/effective/permitted/inheritable/ambient). Mutates `capabilities` in place;
 * pure otherwise (no reliance on outside state), so it's unit-testable independent of
 * whatever the production base spec happens to contain.
 */
export function dropCapabilities(
  capabilities: Record<string, string[] | undefined>,
  drops: ReadonlySet<string>,
): void {
  for (const key of ['bounding', 'effective', 'permitted', 'inheritable', 'ambient']) {
    const list = capabilities[key];
    if (Array.isArray(list)) capabilities[key] = list.filter((c: string) => !drops.has(c));
  }
}

export function buildOciConfig(
  base: GvisorSpecBase,
  cmd: { argv: string[]; cwd: string; env?: Record<string, string> },
): OciConfig {
  const cfg = structuredClone(ociBase) as OciConfig;
  cfg.process.terminal = false;
  cfg.process.cwd = cmd.cwd;
  cfg.process.args = [...cmd.argv];
  cfg.root = { path: base.sessionRootfsDir, readonly: false };

  // Caller-injected env (LANG/LC_ALL/tenant-allowlisted creds) flows in UNDER the
  // sandbox-controlled keys — PATH/HOME/IS_SANDBOX (and the proxy vars below) always win, so a
  // caller cannot override the jail's PATH, home, or egress routing. Mirrors the bwrap backend's
  // cmd.env passthrough (exec-collect.ts) while keeping those keys authoritative for gVisor.
  const env: Record<string, string> = { ...cmd.env, PATH: SANDBOX_PATH, HOME: AGENT_HOME, IS_SANDBOX: '1' };

  cfg.mounts = [
    ...cfg.mounts,
    { destination: AGENT_HOME, source: base.workspaceDir, type: 'bind', options: ['rbind', 'rw'] },
  ];

  // bwrap 백엔드(overlay-rootfs-client.ts buildBwrapArgs)의 network:'proxy' 분기와 동일한
  // socat 루프백 브릿지 계약 — --network=none 인 jail 에서 egress(및 auth-gateway)는
  // 호스트에서 bind-mount 된 유닉스소켓을 통해서만 나간다. 공유 상수/스크립트는
  // socat-bridge.ts 에서 가져온다.
  if (base.network === 'proxy') {
    if (!base.egressSocketPath) {
      throw new Error("buildOciConfig: network 'proxy' requires base.egressSocketPath");
    }
    cfg.mounts.push({
      destination: EGRESS_SOCK_IN_JAIL,
      source: base.egressSocketPath,
      type: 'bind',
      options: ['rbind', 'rw'],
    });
    const bridges: LoopbackBridge[] = [{ listenPort: PROXY_LISTEN_PORT, socketInJail: EGRESS_SOCK_IN_JAIL }];
    env.HTTPS_PROXY = PROXY_URL_IN_JAIL;
    env.HTTP_PROXY = PROXY_URL_IN_JAIL;
    env.https_proxy = PROXY_URL_IN_JAIL;
    env.http_proxy = PROXY_URL_IN_JAIL;
    env.NO_PROXY = '';
    env.no_proxy = '';
    if (base.authGatewaySocketPath) {
      cfg.mounts.push({
        destination: GW_SOCK_IN_JAIL,
        source: base.authGatewaySocketPath,
        type: 'bind',
        options: ['rbind', 'rw'],
      });
      env.ANTHROPIC_BASE_URL = GW_BASE_URL_IN_JAIL;
      // 게이트웨이 자신의 loopback 요청이 egress CONNECT 프록시로 잘못 라우팅되지 않도록
      // NO_PROXY 를 덮어쓴다 — 이 jail netns 안에서 127.0.0.1 은 항상 jail 자신의 socat
      // 브릿지다 (bwrap 분기와 동일한 근거).
      env.NO_PROXY = '127.0.0.1,localhost';
      env.no_proxy = '127.0.0.1,localhost';
      bridges.push({ listenPort: GW_LISTEN_PORT, socketInJail: GW_SOCK_IN_JAIL });
    }
    cfg.process.args = ['/bin/sh', '-lc', loopbackBridgeScript(bridges), 'nexora-egress', ...cmd.argv];
  }

  cfg.process.env = Object.entries(env).map(([k, v]) => `${k}=${v}`);

  // gVisor's `runsc spec` base is already capability-minimal (only CAP_AUDIT_WRITE/
  // CAP_KILL/CAP_NET_BIND_SERVICE), so this drop is defense-in-depth against a future
  // base-spec change or an overridden capDrops list, not something the current base
  // needs — see dropCapabilities' own unit tests for the filter logic itself.
  const drops = new Set(base.capDrops ?? DEFAULT_CAP_DROPS);
  dropCapabilities(cfg.process.capabilities, drops);
  return cfg;
}

export function runscRunArgs(bundleDir: string, id: string, opts: { hostUds: boolean }): string[] {
  const flags = ['--platform=systrap', '--network=none', '--overlay2=none', '--ignore-cgroups'];
  if (opts.hostUds) flags.push('--host-uds=open');
  return [...flags, 'run', '-bundle', bundleDir, id];
}

export interface GvisorOptions {
  /** Volume-backed dir holding per-session state (workspace + rootfs copy + scratch bundles). */
  convDir: string;
  /**
   * Base rootfs. rootfsMode 'copy': 세션마다 이 디렉토리를 통째 복사. 'overlay': 이 디렉토리를
   * host overlayfs 의 RO lower 로 공유한다('/' 면 컨테이너 이미지 전체가 공유 lower).
   */
  baseRootfsDir: string;
  /**
   * 'none' = deny-all (--network=none, 기본). 'proxy' = host-uds bridge egress
   * (overlay 백엔드의 'proxy'와 같은 의도; Task 2에서는 runsc run 플래그 배관만 — 실제
   * 소켓 bind/loopback 브릿지는 후속 작업).
   */
  network?: 'none' | 'proxy';
  /** network:'proxy' 일 때 host-side egress 프록시가 listen 하는 유닉스소켓 경로. */
  egressSocketPath?: string;
  /**
   * Capabilities dropped from the in-jail process (OCI capability sets). Defaults to
   * {@link DEFAULT_CAP_DROPS} — mirrors the bwrap backend's escape-relevant cap list.
   */
  capDrops?: readonly string[];
  /**
   * 세션 rootfs 구성 방식.
   * - 'copy'(기본): baseRootfsDir 를 세션마다 통째 복사(작은 base·비권한 환경용).
   * - 'overlay': host overlayfs 로 baseRootfsDir 를 RO lower 로 공유하고 세션별 upper/work 에 쓰기를
   *   영속시킨다(복사 없음; bwrap --overlay 등가). upper/work 는 convDir(overlayfs 아닌 실 볼륨) 위여야
   *   하고 privileged + `mount`/`umount` 바이너리가 필요하다. exec 는 세션 내 직렬 가정
   *   (overlayfs 는 동일 upper 를 동시에 두 번 mount 할 수 없다 — bwrap 백엔드와 동일 제약).
   */
  rootfsMode?: 'copy' | 'overlay';
  /** Path to the `runsc` binary. Defaults to 'runsc' (resolved via PATH). */
  runscPath?: string;
}

export class GvisorSandboxClient implements SandboxClient {
  private readonly convDir: string;
  private readonly baseRootfsDir: string;
  private readonly network: 'none' | 'proxy';
  private readonly egressSocketPath?: string;
  private readonly capDrops: readonly string[];
  private readonly runscPath: string;
  private readonly rootfsMode: 'copy' | 'overlay';

  constructor(options: GvisorOptions) {
    this.convDir = path.resolve(options.convDir);
    this.baseRootfsDir = path.resolve(options.baseRootfsDir);
    this.network = options.network ?? 'none';
    this.egressSocketPath = options.egressSocketPath;
    if (this.network === 'proxy' && !this.egressSocketPath) {
      throw new Error("GvisorSandboxClient: network 'proxy' requires egressSocketPath");
    }
    this.capDrops = options.capDrops ?? DEFAULT_CAP_DROPS;
    this.runscPath = options.runscPath ?? 'runsc';
    this.rootfsMode = options.rootfsMode ?? 'copy';
  }

  async create(options: WorkspaceAcquireOptions = {}): Promise<WorkspaceSession> {
    const key = typeof options.metadata?.sessionKey === 'string' ? options.metadata.sessionKey : crypto.randomUUID();
    const sessionDir = this.sessionDir(key);
    const workspaceDir = path.join(sessionDir, 'workspace');
    await fsp.mkdir(workspaceDir, { recursive: true, mode: 0o700 });
    if (this.rootfsMode === 'overlay') {
      // host overlayfs: baseRootfsDir(RO lower) 공유 + 세션별 upper/work 에 쓰기 영속(복사 없음).
      // run() 이 exec 마다 이 upper/work 로 merged 를 mount 한다 (bwrap --overlay per-exec 등가).
      await fsp.mkdir(path.join(sessionDir, 'upper'), { recursive: true });
      await fsp.mkdir(path.join(sessionDir, 'work'), { recursive: true });
    } else {
      // copy: baseRootfsDir 를 세션 rootfs 로 통째 복사(gVisor --overlay2=none 이라 쓰기 가능한 사본).
      // verbatimSymlinks: base 의 상대 심링크(/bin/sh→… 등) 보존 (안 하면 runsc "failed to load").
      await fsp.cp(this.baseRootfsDir, path.join(sessionDir, 'rootfs'), {
        recursive: true,
        force: true,
        verbatimSymlinks: true,
      });
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
      // overlay 모드: 설치 영속층(upper)이 있어야 유효한 세션이다.
      if (this.rootfsMode === 'overlay') await fsp.stat(path.join(sessionDir, 'upper'));
    } catch {
      return null;
    }
    await this.touchMeta(sessionDir);
    return this.makeSession(key, sessionDir, workspaceDir);
  }

  /** 디스크가 곧 archive — 삭제는 ArchiveStore.delete 소관이라 여기선 no-op (overlay 미러). */
  async delete(_session: WorkspaceSession): Promise<void> {}

  /** 부팅 검증: 실제 runsc exec 1회. 실패 시 throw (fail-fast 게이트용). */
  async selfCheck(): Promise<void> {
    const key = `selfcheck-${crypto.randomUUID()}`;
    try {
      // create() inside the try so a partially-created session dir (workspace/rootfs copy)
      // is still cleaned up if create() itself throws.
      const session = await this.create({ metadata: { sessionKey: key } });
      const result = await session.run!({ argv: ['/bin/true'], timeoutMs: 30_000 });
      if (result.exitCode !== 0) {
        throw new Error(`gVisor self-check failed (exit=${result.exitCode}): ${result.stderr}`);
      }
    } finally {
      // .catch so a cleanup failure can't mask the real self-check error (finally-throw overrides).
      await fsp.rm(this.sessionDir(key), { recursive: true, force: true }).catch(() => {});
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
    const network = this.network;
    const egressSocketPath = this.egressSocketPath;
    const capDrops = this.capDrops;
    const runscPath = this.runscPath;
    const rootfsMode = this.rootfsMode;
    const baseRootfsDir = this.baseRootfsDir;
    const upperDir = path.join(sessionDir, 'upper');
    const workDir = path.join(sessionDir, 'work');
    const copyRootfsDir = path.join(sessionDir, 'rootfs');
    // 에이전트가 보는 논리 root 는 /home/agent(AGENT_HOME); 호스트 backing 은 workspaceDir.
    // overlay 백엔드와 동일 계약 — fs-wire(서버 host-side fsp)는 backing 을 읽는다.
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
        const bundleDir = await fsp.mkdtemp(path.join(sessionDir, 'bundle-'));
        const merged = path.join(bundleDir, 'merged');
        try {
          // overlay 모드: exec 마다 host overlayfs(lower=base RO, upper=세션 영속층)를 merged 로 mount
          // (bwrap --overlay per-exec 와 동일 의미론); copy 모드: 세션 복사본 그대로 사용.
          let sessionRootfsDir: string;
          if (rootfsMode === 'overlay') {
            await fsp.mkdir(merged, { recursive: true });
            await mountOverlay(baseRootfsDir, upperDir, workDir, merged);
            sessionRootfsDir = merged;
          } else {
            sessionRootfsDir = copyRootfsDir;
          }
          const cfg = buildOciConfig(
            { sessionRootfsDir, workspaceDir, network, egressSocketPath, capDrops },
            { argv: cmd.argv, cwd, env: cmd.env },
          );
          await fsp.writeFile(path.join(bundleDir, 'config.json'), JSON.stringify(cfg));
          const id = `s-${path.basename(bundleDir)}`;
          return await spawnCollect(
            runscPath,
            runscRunArgs(bundleDir, id, { hostUds: network === 'proxy' }),
            cmd,
          );
        } finally {
          if (rootfsMode === 'overlay') await umountQuiet(merged);
          await fsp.rm(bundleDir, { recursive: true, force: true }).catch(() => {});
        }
      },
      async cleanup(): Promise<void> {},
    };
  }
}

/** seedDirs 를 workspace 안으로 best-effort 복사 (심링크 제외 — root-jail 보호). overlay 백엔드와 동일. */
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

