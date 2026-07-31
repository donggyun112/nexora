import { describe, expect, it } from 'vitest';

import { buildBwrapArgs } from '../overlay-rootfs-client.js';

/**
 * sourceRoot — 컨테이너 rootfs 를 "다른 경로에 비친 뷰"에서 읽게 한다.
 *
 * **왜 필요한가.** 잽을 shift-map userns(inner 1..65536 → outer 100000..) 안에서 돌리면
 * 탈출해도 비특권 uid 가 되어 대화 간 경계가 커널 격리 없이 선다. 그런데 그냥 shift 하면
 * 이미지 안 기존 파일의 소유자가 매핑 밖으로 나간다 — 게스트 실측: `/etc/gshadow`(0:42)가
 * ns 안에서 `0:65534`(overflow)로 보여 `useradd` 가 `cannot open /etc/gshadow` 로 죽는다.
 * apt postinst 계열이 통째로 깨진다는 뜻이다.
 *
 * 해법은 rootfs 를 **idmapped bind** 로 shift 해서 보여주는 것이다(util-linux 2.41
 * `mount --bind -o X-mount.idmap=...`). 그 뷰 위에서는 ns 안 소유권이 `0:42` 로 정상 복원되고
 * useradd/chown/overlay write 가 전부 통과한다(게스트 실측 확인).
 *
 * 그러려면 bwrap 이 **컨테이너 rootfs 를 가리키는 소스 경로**만 그 뷰 아래에서 읽어야 한다.
 * 우리가 소유하는 경로(sessionDir 의 upper/work, workspace, 소켓)는 idmapped 뷰 밖 게스트
 * ext4 에 있고 shift 대상이 아니므로 **건드리면 안 된다** — 옮기면 존재하지 않는 경로가 된다.
 */
describe('buildBwrapArgs sourceRoot', () => {
  const base = {
    convDir: '/vol/conv',
    sessionDir: '/vol/conv/abc',
    workspaceDir: '/vol/conv/abc/workspace',
    systemDirs: ['usr', 'etc'],
    network: 'none' as const,
  };
  const cmd = { argv: ['python3', '-V'], cwd: '/home/agent' };

  it('기본값은 기존과 동일하다 — 루트를 그대로 읽는다', () => {
    const args = buildBwrapArgs(base, cmd);
    expect(args.slice(0, 3)).toEqual(['--ro-bind', '/', '/']);
    expect(args.join(' ')).toContain('--overlay-src /usr ');
  });

  it('sourceRoot 를 주면 rootfs 소스가 그 아래로 옮겨간다', () => {
    const args = buildBwrapArgs({ ...base, sourceRoot: '/run/nexora/idmap' }, cmd);
    expect(args.slice(0, 3)).toEqual(['--ro-bind', '/run/nexora/idmap', '/']);
    const s = args.join(' ');
    expect(s).toContain('--overlay-src /run/nexora/idmap/usr --overlay /vol/conv/abc/upper/usr /vol/conv/abc/work/usr /usr');
    expect(s).toContain('--overlay-src /run/nexora/idmap/etc --overlay /vol/conv/abc/upper/etc /vol/conv/abc/work/etc /etc');
  });

  it('우리가 소유하는 경로는 shift 하지 않는다', () => {
    const s = buildBwrapArgs({ ...base, sourceRoot: '/run/nexora/idmap' }, cmd).join(' ');
    // upper/work/workspace/convDir 은 게스트 ext4 의 실제 경로다 — 뷰 아래로 옮기면 없는 경로가 된다.
    expect(s).not.toContain('/run/nexora/idmap/vol/conv');
    expect(s).toContain('--tmpfs /vol/conv');
  });

  it('상대경로 sourceRoot 는 거부한다', () => {
    // 잘못 넘기면 bwrap 이 cwd 기준으로 해석해 조용히 엉뚱한 트리를 잽에 건다.
    expect(() => buildBwrapArgs({ ...base, sourceRoot: 'idmap' }, cmd)).toThrow(/sourceRoot/);
  });
});
