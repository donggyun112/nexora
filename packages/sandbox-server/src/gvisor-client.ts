import ociBase from './oci-base.js';

const AGENT_HOME = '/home/agent';
const SANDBOX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
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
