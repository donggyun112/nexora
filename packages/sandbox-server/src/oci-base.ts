// Generated from oci-base.json (captured via `runsc spec` on Linux). Kept as a .ts module
// rather than a JSON import — tsc's composite/project-reference build rejects a JSON file
// pulled in only via `import ... with { type: 'json' }` (TS6307: not listed in the project's
// file list), even with resolveJsonModule enabled. This literal is the same data, verbatim.
export default {
  ociVersion: '1.0.0',
  process: {
    user: {
      uid: 0,
      gid: 0,
    },
    args: ['sh'],
    env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'TERM=xterm'],
    cwd: '/',
    capabilities: {
      bounding: ['CAP_AUDIT_WRITE', 'CAP_KILL', 'CAP_NET_BIND_SERVICE'],
      effective: ['CAP_AUDIT_WRITE', 'CAP_KILL', 'CAP_NET_BIND_SERVICE'],
      inheritable: ['CAP_AUDIT_WRITE', 'CAP_KILL', 'CAP_NET_BIND_SERVICE'],
      permitted: ['CAP_AUDIT_WRITE', 'CAP_KILL', 'CAP_NET_BIND_SERVICE'],
    },
    rlimits: [
      {
        type: 'RLIMIT_NOFILE',
        hard: 1024,
        soft: 1024,
      },
    ],
  },
  root: {
    path: 'rootfs',
    readonly: true,
  },
  hostname: 'runsc',
  mounts: [
    {
      destination: '/proc',
      type: 'proc',
      source: 'proc',
    },
    {
      destination: '/dev',
      type: 'tmpfs',
      source: 'tmpfs',
    },
    {
      destination: '/sys',
      type: 'sysfs',
      source: 'sysfs',
      options: ['nosuid', 'noexec', 'nodev', 'ro'],
    },
  ],
  linux: {
    namespaces: [{ type: 'pid' }, { type: 'network' }, { type: 'ipc' }, { type: 'uts' }, { type: 'mount' }],
  },
} as const;
