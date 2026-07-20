import crypto from 'node:crypto';
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
import { SANDBOX_PATH, spawnCollect } from './exec-collect.js';
import ociBase from './oci-base.js';

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

export function buildOciConfig(base: GvisorSpecBase, cmd: { argv: string[]; cwd: string }): OciConfig {
  const cfg = structuredClone(ociBase) as OciConfig;
  cfg.process.terminal = false;
  cfg.process.cwd = cmd.cwd;
  cfg.process.args = [...cmd.argv];
  cfg.root = { path: base.sessionRootfsDir, readonly: false };

  const env: Record<string, string> = { PATH: SANDBOX_PATH, HOME: AGENT_HOME, IS_SANDBOX: '1' };
  cfg.process.env = Object.entries(env).map(([k, v]) => `${k}=${v}`);

  cfg.mounts = [
    ...cfg.mounts,
    { destination: AGENT_HOME, source: base.workspaceDir, type: 'bind', options: ['rbind', 'rw'] },
  ];

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
  /** Template rootfs directory copied into each session's private rootfs (e.g. a busybox set). */
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
  }

  async create(options: WorkspaceAcquireOptions = {}): Promise<WorkspaceSession> {
    const key = typeof options.metadata?.sessionKey === 'string' ? options.metadata.sessionKey : crypto.randomUUID();
    const sessionDir = this.sessionDir(key);
    const workspaceDir = path.join(sessionDir, 'workspace');
    const rootfsDir = path.join(sessionDir, 'rootfs');
    await fsp.mkdir(workspaceDir, { recursive: true, mode: 0o700 });
    // 세션 전용 rootfs 를 base 템플릿에서 복사 시딩한다(overlay 백엔드의 upper/work 대응 —
    // gVisor 는 --overlay2=none 이라 rootfs 자체가 세션 수명 동안 쓰기 가능한 사본이어야 함).
    await fsp.cp(this.baseRootfsDir, rootfsDir, { recursive: true, force: true });
    await this.touchMeta(sessionDir);
    await seedInto(workspaceDir, options.seedDirs);
    return this.makeSession(key, sessionDir, workspaceDir, rootfsDir);
  }

  /** 기존 conv 디렉토리로 세션 핸들을 재구성한다 (thaw 용). 없으면 null. */
  async attach(key: string): Promise<WorkspaceSession | null> {
    const sessionDir = this.sessionDir(key);
    const workspaceDir = path.join(sessionDir, 'workspace');
    const rootfsDir = path.join(sessionDir, 'rootfs');
    try {
      const stat = await fsp.stat(workspaceDir);
      if (!stat.isDirectory()) return null;
    } catch {
      return null;
    }
    await this.touchMeta(sessionDir);
    return this.makeSession(key, sessionDir, workspaceDir, rootfsDir);
  }

  /** 디스크가 곧 archive — 삭제는 ArchiveStore.delete 소관이라 여기선 no-op (overlay 미러). */
  async delete(_session: WorkspaceSession): Promise<void> {}

  /** 부팅 검증: 실제 runsc exec 1회. 실패 시 throw (fail-fast 게이트용). */
  async selfCheck(): Promise<void> {
    const key = `selfcheck-${crypto.randomUUID()}`;
    const session = await this.create({ metadata: { sessionKey: key } });
    try {
      const result = await session.run!({ argv: ['/bin/true'], timeoutMs: 30_000 });
      if (result.exitCode !== 0) {
        throw new Error(`gVisor self-check failed (exit=${result.exitCode}): ${result.stderr}`);
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

  private makeSession(key: string, sessionDir: string, workspaceDir: string, rootfsDir: string): WorkspaceSession {
    const network = this.network;
    const egressSocketPath = this.egressSocketPath;
    const capDrops = this.capDrops;
    const runscPath = this.runscPath;
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
        const cfg = buildOciConfig(
          { sessionRootfsDir: rootfsDir, workspaceDir, network, egressSocketPath, capDrops },
          { argv: cmd.argv, cwd },
        );
        const bundleDir = await fsp.mkdtemp(path.join(sessionDir, 'bundle-'));
        await fsp.writeFile(path.join(bundleDir, 'config.json'), JSON.stringify(cfg));
        const id = `s-${path.basename(bundleDir)}`;
        try {
          return await spawnCollect(
            runscPath,
            runscRunArgs(bundleDir, id, { hostUds: network === 'proxy' }),
            cmd,
          );
        } finally {
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

