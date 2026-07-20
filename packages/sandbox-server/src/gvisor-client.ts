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

// OciConfig는 우리가 건드리는 필드만 느슨히 타입핑; 전체는 oci-base.json 구조.
type OciConfig = Record<string, any>;

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

  const drops = new Set(base.capDrops ?? DEFAULT_CAP_DROPS);
  const caps = cfg.process.capabilities;
  for (const key of ['bounding', 'effective', 'permitted', 'inheritable', 'ambient']) {
    if (Array.isArray(caps[key])) caps[key] = caps[key].filter((c: string) => !drops.has(c));
  }
  return cfg;
}

export function runscRunArgs(bundleDir: string, id: string, opts: { hostUds: boolean }): string[] {
  const flags = ['--platform=systrap', '--network=none', '--overlay2=none', '--ignore-cgroups'];
  if (opts.hostUds) flags.push('--host-uds=open');
  return [...flags, 'run', '-bundle', bundleDir, id];
}
