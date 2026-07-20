# gVisor Sandbox Backend (A1′) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(권장) 또는 `superpowers:executing-plans`로 task 단위 실행. 스텝은 `- [ ]` 체크박스.

**Goal:** nexora `SandboxClient` seam 뒤에 gVisor(runsc) 격리 backend `GvisorSandboxClient`를 추가해, `SANDBOX_BACKEND=gvisor`로 신뢰 불가 에이전트 코드에 실제 격리 경계(KVM 불필요)를 제공한다.

**Architecture:** `OverlayRootfsSandboxClient`(bwrap)를 미러. exec마다 `runsc run`을 자식 프로세스로 스폰. 세션 rootfs는 base 이미지 시딩 + `--overlay2=none`로 설치 영속, 워크스페이스는 bind 볼륨, egress/auth 소켓은 `--host-uds`+socat 브리지. 서버 라우트·`SessionRegistry`·`DurableDirStore`·egress-proxy·auth-gateway는 무변경 재사용.

**Tech Stack:** TypeScript(ESM), gVisor `runsc` OCI CLI, Node `child_process`, vitest. 스펙: `docs/superpowers/specs/2026-07-20-gvisor-sandbox-backend-design.md`.

## Global Constraints

- 설치 식별자는 `@dongkseo/*`만. 역방향 import 금지(→ `@dongkseo/contracts` 수렴). 커밋/PR AI 서명 금지.
- 계약 정본: `packages/contracts/src/workspace.ts` — `SandboxClient.create()`(필수), `WorkspaceSession`(id/root/hostRoot?/mode/mounts/resolve/run?/cleanup). 관례 확장 `attach()`·`selfCheck()`도 미러(`DurableDirStore`·`main.ts`가 사용).
- 참조 템플릿: `packages/sandbox-server/src/overlay-rootfs-client.ts`. 구조/네이밍/테스트 패턴을 그대로 미러.
- runsc 없는 호스트에서 `selfCheck()`는 fail-fast. runsc 의존 테스트는 runsc 부재 시 **skip**(단위 테스트는 항상 실행).
- 순수 함수(`buildOciConfig`/`runscRunArgs`)는 I/O 금지(테스트 표면 계약 — `buildBwrapArgs`와 동일).

---

## File Structure

- **Create** `packages/sandbox-server/src/oci-base.json` — `runsc spec` 기본 config.json 스냅샷(vetted 베이스, mutate 원본).
- **Create** `packages/sandbox-server/src/exec-collect.ts` — `spawnCollect`+`SANDBOX_PATH`를 overlay 클라이언트에서 추출(공유).
- **Create** `packages/sandbox-server/src/gvisor-client.ts` — `buildOciConfig`, `runscRunArgs`, `GvisorSandboxClient`.
- **Create** `packages/sandbox-server/src/__tests__/gvisor-client.test.ts`.
- **Modify** `packages/sandbox-server/src/overlay-rootfs-client.ts` — `spawnCollect`/`SANDBOX_PATH`를 `exec-collect.ts`에서 import(중복 제거).
- **Modify** `packages/sandbox-server/src/index.ts` — export.
- **Modify** `agent-sandbox/src/main.ts` — `SANDBOX_BACKEND=gvisor` 분기.
- **Modify** `packages/sandbox-server/README.md`, `docs/architecture/packages-map.md`.

---

## Task 1: 순수 함수 `buildOciConfig` + `runscRunArgs`

**Files:**
- Create: `packages/sandbox-server/src/oci-base.json`
- Create: `packages/sandbox-server/src/gvisor-client.ts`
- Test: `packages/sandbox-server/src/__tests__/gvisor-client.test.ts`

**Interfaces:**
- Produces: `buildOciConfig(base: GvisorSpecBase, cmd: {argv:string[];cwd:string}): OciConfig`(순수), `runscRunArgs(bundleDir:string, id:string, opts:{hostUds:boolean}): string[]`(순수), `GvisorSpecBase`(sessionRootfsDir, workspaceDir, network:'none'|'proxy', egressSocketPath?, authGatewaySocketPath?, capDrops?).

- [ ] **Step 1: `oci-base.json` 캡처**

runsc 있는 리눅스에서 `runsc spec` 실행 → 생성된 `config.json`을 `packages/sandbox-server/src/oci-base.json`로 커밋. (runsc 부재 개발자용) 스냅샷은 표준 OCI 기본 spec이며 `process.args=["sh"]`, `root={"path":"rootfs","readonly":true}`, `linux.namespaces`에 pid/network/ipc/uts/mount, `mounts`에 proc/dev/sys/tmpfs, `process.capabilities`에 기본 cap 세트를 포함한다. 이 파일은 mutate 원본일 뿐 — 값 정확성은 Step 4 통합 테스트가 검증.

- [ ] **Step 2: 실패 테스트 작성** (`gvisor-client.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { buildOciConfig, runscRunArgs } from '../gvisor-client.js';

const base = { sessionRootfsDir: '/conv/s1/rootfs', workspaceDir: '/conv/s1/workspace', network: 'none' as const };

describe('buildOciConfig (network none)', () => {
  it('roots at the session rootfs, writable', () => {
    const c = buildOciConfig(base, { argv: ['/bin/echo', 'hi'], cwd: '/home/agent' });
    expect(c.root).toEqual({ path: '/conv/s1/rootfs', readonly: false });
  });
  it('bind-mounts the workspace at /home/agent rw', () => {
    const c = buildOciConfig(base, { argv: ['x'], cwd: '/home/agent' });
    const m = c.mounts.find((m: any) => m.destination === '/home/agent');
    expect(m).toMatchObject({ source: '/conv/s1/workspace', type: 'bind', options: ['rbind', 'rw'] });
  });
  it('sets args, cwd, terminal=false, and PATH/HOME env', () => {
    const c = buildOciConfig(base, { argv: ['/bin/sh', '-c', 'true'], cwd: '/home/agent/x' });
    expect(c.process.args).toEqual(['/bin/sh', '-c', 'true']);
    expect(c.process.cwd).toBe('/home/agent/x');
    expect(c.process.terminal).toBe(false);
    expect(c.process.env).toContain('HOME=/home/agent');
    expect(c.process.env.some((e: string) => e.startsWith('PATH='))).toBe(true);
  });
  it('drops escape-relevant capabilities', () => {
    const c = buildOciConfig(base, { argv: ['x'], cwd: '/' });
    const all = [...c.process.capabilities.bounding, ...c.process.capabilities.effective];
    expect(all).not.toContain('CAP_SYS_ADMIN');
    expect(all).not.toContain('CAP_SYS_PTRACE');
  });
  it('does not mutate the shared base template between calls', () => {
    const a = buildOciConfig(base, { argv: ['a'], cwd: '/' });
    const b = buildOciConfig(base, { argv: ['b'], cwd: '/' });
    expect(a.process.args).toEqual(['a']);
    expect(b.process.args).toEqual(['b']);
  });
});

describe('runscRunArgs', () => {
  it('systrap + no-KVM flags, bundle+id, host-uds only when requested', () => {
    expect(runscRunArgs('/b', 'id1', { hostUds: false })).toEqual([
      '--platform=systrap', '--network=none', '--overlay2=none', '--ignore-cgroups', 'run', '-bundle', '/b', 'id1',
    ]);
    expect(runscRunArgs('/b', 'id1', { hostUds: true })).toContain('--host-uds=open');
  });
});
```

- [ ] **Step 3: 실패 확인** — `pnpm --filter @dongkseo/sandbox-server test -- gvisor-client` → FAIL(모듈 없음).

- [ ] **Step 4: 최소 구현** (`gvisor-client.ts`)

```ts
import ociBase from './oci-base.json' with { type: 'json' };

const AGENT_HOME = '/home/agent';
const SANDBOX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
// bwrap 백엔드와 동일한 탈출-관련 cap 세트 (overlay-rootfs-client.ts DEFAULT_CAP_DROPS 미러)
const DEFAULT_CAP_DROPS: readonly string[] = [
  'CAP_SYS_ADMIN','CAP_MKNOD','CAP_DAC_READ_SEARCH','CAP_SYS_MODULE','CAP_SYS_RAWIO',
  'CAP_SYS_PTRACE','CAP_SYS_BOOT','CAP_SYS_TIME','CAP_SYSLOG','CAP_NET_ADMIN','CAP_NET_RAW',
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
```

- [ ] **Step 5: 통과 확인** — 테스트 PASS. `pnpm --filter @dongkseo/sandbox-server build`도 통과.

- [ ] **Step 6: 커밋** — `feat(sandbox-server): buildOciConfig + runscRunArgs (gVisor pure fns)`

---

## Task 2: `GvisorSandboxClient` (create/attach/delete/selfCheck/run)

**Files:**
- Create: `packages/sandbox-server/src/exec-collect.ts`
- Modify: `packages/sandbox-server/src/overlay-rootfs-client.ts`(spawnCollect 추출 import)
- Modify: `packages/sandbox-server/src/gvisor-client.ts`
- Test: `packages/sandbox-server/src/__tests__/gvisor-client.test.ts`

**Interfaces:**
- Consumes: `buildOciConfig`, `runscRunArgs`(T1); `SandboxClient`/`WorkspaceSession`/`SandboxCommand`/`SandboxCommandResult`(contracts).
- Produces: `class GvisorSandboxClient`(create/attach/delete/selfCheck), `GvisorOptions`(convDir, baseRootfsDir, network?, egressSocketPath?, capDrops?, runscPath?).

- [ ] **Step 1: `spawnCollect` 추출** — `overlay-rootfs-client.ts`의 `spawnCollect`와 `SANDBOX_PATH`를 `exec-collect.ts`로 옮겨 export하고, overlay 클라이언트는 거기서 import. 기존 overlay 테스트가 여전히 PASS인지 확인(회귀 없음). 커밋: `refactor(sandbox-server): extract spawnCollect to exec-collect`.

- [ ] **Step 2: 단위 테스트 작성**(runsc 불요 — 세션 형태/경로 매핑)

```ts
import { GvisorSandboxClient } from '../gvisor-client.js';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

it('create() returns a session rooted at /home/agent with hostRoot=workspace', async () => {
  const convDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gv-'));
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gvbase-'));
  await fsp.mkdir(path.join(base, 'bin'), { recursive: true });
  const client = new GvisorSandboxClient({ convDir, baseRootfsDir: base });
  const s = await client.create({ metadata: { sessionKey: 'k1' } });
  expect(s.root).toBe('/home/agent');
  expect(s.hostRoot).toBe(path.join(convDir, 'k1', 'workspace'));
  const r = await s.resolve('a/b.txt');
  expect(r.path).toBe(path.join(s.hostRoot!, 'a/b.txt'));
});

it('resolve() rejects workspace escape', async () => {
  const convDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gv-'));
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gvbase-'));
  const client = new GvisorSandboxClient({ convDir, baseRootfsDir: base });
  const s = await client.create({ metadata: { sessionKey: 'k2' } });
  await expect(s.resolve('../escape')).rejects.toThrow(/escapes workspace/);
});
```

- [ ] **Step 3: 실패 확인** — FAIL(클래스 없음).

- [ ] **Step 4: 구현** — `OverlayRootfsSandboxClient`를 미러하되 아래만 변경. `create`/`attach`/`sessionDir`/`touchMeta`/`delete(no-op)`/`makeSession`의 resolve·hostRoot·toHostRel·seedInto 로직은 **overlay 클라이언트에서 그대로 옮겨온다**(동일 계약). 차이점:

```ts
// create(): overlay upper/work 대신 세션 rootfs를 base에서 시딩
const rootfsDir = path.join(sessionDir, 'rootfs');
await fsp.cp(this.baseRootfsDir, rootfsDir, { recursive: true, force: true }); // 가능하면 --reflink (Step 6 최적화)

// run(): bwrap 스폰 대신 per-exec 번들 작성 후 runsc 스폰
async run(cmd: SandboxCommand): Promise<SandboxCommandResult> {
  const cwd = cmd.cwd ?? AGENT_HOME;
  const cfg = buildOciConfig(
    { sessionRootfsDir: rootfsDir, workspaceDir, network: this.network,
      egressSocketPath: this.egressSocketPath },
    { argv: cmd.argv, cwd },
  );
  const bundleDir = await fsp.mkdtemp(path.join(sessionDir, 'bundle-'));
  await fsp.writeFile(path.join(bundleDir, 'config.json'), JSON.stringify(cfg));
  const id = `s-${path.basename(bundleDir)}`;
  try {
    return await spawnCollect(this.runscPath, runscRunArgs(bundleDir, id, { hostUds: this.network === 'proxy' }), cmd);
  } finally {
    await fsp.rm(bundleDir, { recursive: true, force: true }).catch(() => {});
  }
}

// selfCheck(): 실제 runsc run 1회 (bwrap selfCheck 미러)
async selfCheck(): Promise<void> {
  const session = await this.create({ metadata: { sessionKey: `selfcheck-${crypto.randomUUID()}` } });
  const r = await session.run!({ argv: ['/bin/true'], timeoutMs: 30_000 });
  if (r.exitCode !== 0) throw new Error(`gVisor self-check failed (exit=${r.exitCode}): ${r.stderr}`);
  // 세션 dir 정리 (bwrap 미러)
}
```

`GvisorOptions`: `{ convDir, baseRootfsDir, network='none', egressSocketPath?, capDrops?, runscPath='runsc' }`. `network==='proxy' && !egressSocketPath` → 생성자에서 throw(overlay 미러).

- [ ] **Step 5: 통과 확인** — 단위 테스트 PASS.

- [ ] **Step 6: runsc-gated 통합 테스트** — runsc 있을 때만:

```ts
import { execSync } from 'node:child_process';
const HAS_RUNSC = (() => { try { execSync('runsc --version', { stdio: 'ignore' }); return true; } catch { return false; } })();
const gated = HAS_RUNSC ? it : it.skip;

gated('selfCheck passes and installs persist across two runs', async () => {
  // base rootfs = busybox 세트, client 생성, session.run(설치 흉내: 파일 write to /opt/marker),
  // 두 번째 run에서 cat /opt/marker → 첫 write가 보이는지(=--overlay2=none 영속) assert.
}, 60_000);
```

- [ ] **Step 7: 커밋** — `feat(sandbox-server): GvisorSandboxClient (runsc backend, network=none)`

---

## Task 3: egress 'proxy' — host-uds + socat 브리지

**Files:** Modify `gvisor-client.ts`(buildOciConfig proxy 분기), Test 추가.

**Interfaces:**
- Consumes: `startEgressProxy`/`startAuthInjectingGateway`(sandbox-server), T2 client.
- Produces: buildOciConfig의 `network:'proxy'` 동작(소켓 bind + socat 래핑 + proxy env).

- [ ] **Step 1: 실패 테스트**(순수 — proxy 분기)

```ts
it('proxy: binds egress/gw sockets, wraps args in socat bridge, injects proxy env', () => {
  const c = buildOciConfig(
    { sessionRootfsDir: '/r', workspaceDir: '/w', network: 'proxy',
      egressSocketPath: '/run/egress.sock', authGatewaySocketPath: '/run/gw.sock' },
    { argv: ['claude', '-p'], cwd: '/home/agent' });
  expect(c.mounts.find((m: any) => m.destination === '/run/nexora/egress.sock')).toMatchObject({ source: '/run/egress.sock', type: 'bind' });
  expect(c.mounts.find((m: any) => m.destination === '/run/nexora/gateway.sock')).toMatchObject({ source: '/run/gw.sock' });
  expect(c.process.args[0]).toBe('/bin/sh'); // socat bridge launcher wraps the real cmd
  expect(c.process.env).toContain('HTTPS_PROXY=http://127.0.0.1:3128');
  expect(c.process.env).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:3129');
});
```

- [ ] **Step 2: 실패 확인** — FAIL.

- [ ] **Step 3: 구현** — `overlay-rootfs-client.ts`의 `loopbackBridgeScript`(순수)와 상수(`EGRESS_SOCK_IN_JAIL`=`/run/nexora/egress.sock`, `PROXY_LISTEN_PORT`=3128, `GW_SOCK_IN_JAIL`=`/run/nexora/gateway.sock`, `GW_LISTEN_PORT`=3129)를 공유 모듈(`socat-bridge.ts`)로 추출 후 `buildOciConfig`에서 재사용. proxy일 때: 소켓들을 `mounts` bind로 추가, `process.args`를 `['/bin/sh','-lc', loopbackBridgeScript(bridges), 'nexora-egress', ...cmd.argv]`로 감싸고, env에 `HTTPS_PROXY`/`HTTP_PROXY`(+소문자)/`NO_PROXY=127.0.0.1,localhost`/`ANTHROPIC_BASE_URL` 주입. (bwrap `buildBwrapArgs` proxy 분기와 동일 의미론 — 그 파일을 근거로 값 일치.)

- [ ] **Step 4: 통과 확인** — 순수 테스트 PASS.

- [ ] **Step 5: runsc-gated 통합 테스트** — host-uds 실검증: 호스트에서 `startEgressProxy`로 유닉스소켓 리스너 띄우고, 세션에서 `wget -q -O- http://<allowed>` 를 프록시 경유로 실행 → allowlist 도메인 성공/비허용 실패. runsc 부재 시 skip.

- [ ] **Step 6: 커밋** — `feat(sandbox-server): gVisor egress proxy + auth-gateway via --host-uds`

---

## Task 4: 배선 — export + `SANDBOX_BACKEND=gvisor` + 문서

**Files:** Modify `index.ts`, `agent-sandbox/src/main.ts`, `README.md`, `packages-map.md`.

**Interfaces:**
- Consumes: `GvisorSandboxClient`(T2/T3).

- [ ] **Step 1: export** — `index.ts`에 `export { GvisorSandboxClient, buildOciConfig, runscRunArgs, type GvisorOptions } from './gvisor-client.js';`. build 통과.

- [ ] **Step 2: `main.ts` 분기** — `backend === 'gvisor'`:

```ts
} else if (backend === 'gvisor') {
  const baseRootfsDir = process.env.SANDBOX_BASE_ROOTFS;
  if (!baseRootfsDir) { console.error('[sandbox-server] SANDBOX_BASE_ROOTFS required for gvisor backend'); await egressProxy?.close(); process.exit(1); }
  const gv = new GvisorSandboxClient(
    convNet === 'proxy'
      ? { convDir, baseRootfsDir, network: 'proxy', egressSocketPath }
      : { convDir, baseRootfsDir });
  try { await gv.selfCheck(); } catch (err) { console.error('[sandbox-server] gvisor self-check failed:', err); await egressProxy?.close(); process.exit(1); }
  client = gv;
  archiveStore = new DurableDirStore(gv, { convDir });
  console.log(`[sandbox-server] backend=gvisor conv=${convDir} base=${baseRootfsDir} egress=${convNet ?? 'none'}`);
}
```

(egress 프록시 기동 조건 `convNet === 'proxy'`는 overlay와 공유되므로 기존 위치 그대로.)

- [ ] **Step 3: 배포 문서** — runsc 설치 + 컨테이너 **privileged**(nested systrap 요건) + `SANDBOX_BASE_ROOTFS` env를 `main.ts` 상단 주석과 README에 명시. `packages-map.md`에 gvisor backend 행 추가.

- [ ] **Step 4: 커밋** — `feat(sandbox-server): wire SANDBOX_BACKEND=gvisor + docs`

---

## Self-Review

- **스펙 커버리지:** 세션/rootfs/영속(T1·T2), egress/auth host-uds(T3), 배선/배포(T4), selfCheck 게이트(T2·T4) — 스펙 전 섹션 대응. ✓
- **Placeholder:** 없음(실코드/실테스트). runsc-gated 통합 테스트 본문은 의도적으로 시나리오 기술(구현자가 base rootfs 준비) — 단위 테스트는 완전.
- **타입 일관성:** `GvisorSpecBase`/`GvisorOptions`/`buildOciConfig`/`runscRunArgs` 시그니처가 T1→T2→T3에서 일치. `spawnCollect`는 T2 Step1에서 공유 모듈화 후 재사용.
- **미해결(구현 중 확인):** `--host-uds=open`이 socat connect에 충분한지 T3 Step5가 실검증(안 되면 `all`로). `oci-base.json`의 정확성은 T2 Step6 통합 테스트가 게이트.
