# gVisor Sandbox Backend (A1′) — 설계 스펙

**날짜:** 2026-07-20
**상태:** drafting (스파이크 통과, 구현 전)
**관련:** ADR-002(정체성=단일 에이전트 런타임), `packages/sandbox-server`, `agent-sandbox/src/main.ts`

> **For agentic workers:** 이 스펙이 승인되면 `superpowers:writing-plans`로 구현 계획을 만든다.

## Goal

nexora `SandboxClient` seam 뒤에 **gVisor(runsc) 기반 격리 backend**(`GvisorSandboxClient`)를 하나 추가해, 에이전트가 실행하는 신뢰 불가 코드에 대해 **호스트 커널 공유가 아닌 실제 격리 경계**를 제공한다 — KVM 없이 어떤 리눅스/Docker 환경에서든.

## Architecture (2-3문장)

기존 `createSandboxServer({ client })` 서버·라우트·세션 lifecycle은 **전부 그대로** 두고, `client`로 주입하는 OS-격리 backend만 교체한다. `GvisorSandboxClient`는 현재 `OverlayRootfsSandboxClient`(bwrap)와 동일한 계약을 구현하되, **exec마다 `runsc run`을 자식 프로세스로 스폰**(A1′: raw runsc, 컨테이너 런타임 데몬 없음)한다. 배포는 `agent-sandbox/src/main.ts`의 `SANDBOX_BACKEND=gvisor` 3번째 옵션.

## Tech Stack

- gVisor `runsc` (systrap 플랫폼, KVM 불필요), OCI 런타임 CLI (`runsc run -bundle <dir> <id>`)
- Node `child_process.spawn` (기존 `spawnCollect` 재사용)
- 기존 `@dongkseo/sandbox-server` 부품: `SessionRegistry`, `DurableDirStore`, `startEgressProxy`, `startAuthInjectingGateway`

---

## Global Constraints

- 설치 패키지 식별자는 **`@dongkseo/*`** 뿐 (`@nexora`는 없음).
- **역방향 import 금지** — 모든 패키지는 `@dongkseo/contracts`로 수렴.
- 커밋/PR에 AI 서명·attribution 금지.
- 새 backend는 `SandboxClient`(create 필수, resume?/delete? 선택) + `WorkspaceSession`(resolve/run?/cleanup, hostRoot? 등) 계약을 **정본(`packages/contracts/src/workspace.ts`)** 그대로 만족해야 한다. 관례 확장 `attach()`·`selfCheck()`도 미러한다(각각 `DurableDirStore` thaw·`main.ts` 자체검사 게이트가 사용).
- runsc 없는 호스트에서 **조용히 뜨지 않는다** — `selfCheck()`가 실제 `runsc run` 1회로 fail-fast (bwrap 게이트와 대칭).

---

## 배경 / 현재 상태 (사실)

- `packages/sandbox-server`는 wire 프로토콜 **참조 구현**이다: `createSandboxServer({ client, token, lifecycle, archiveStore, rootAllowPrefixes })`가 모든 라우트(create/exec/fs/persist/hydrate/reattach/delete)+bearer+경로 root-jail을 처리하고, 격리 backend를 **주입**받는다.
- 현행 backend: `asrt`(seatbelt/bwrap, `@dongkseo/core`) / `overlay`(`OverlayRootfsSandboxClient`, bwrap `--overlay`).
- 배포물 = `agent-sandbox`(장수 HTTP 서버 컨테이너). 앱 컨테이너가 `RemoteSandboxClient`로 접속. 잽은 **exec마다 자식 프로세스로 스폰**(디스크 상태 위에), persist/hydrate/reattach는 `SessionRegistry`+`DurableDirStore`가 backend 무관하게 처리.

## 문제 (왜 gVisor가 필요한가)

`OverlayRootfsSandboxClient`(bwrap)는 코드 주석이 명시하듯 *"userns 없이 uid 0으로 돌고, 격리는 mount/pid/ipc/net 네임스페이스 + overlay에서 온다"* — 즉 **컨테이너 티어, 호스트 커널 공유**다. 커널 LPE 하나면 탈출. ADR-002의 위협 모델(에이전트가 실행하는 LLM 생성/주입 코드 = 신뢰 불가)에 대해 **경계가 아니라 위생(hygiene)**이다.

gVisor는 애플리케이션 커널(Sentry)을 유저스페이스에서 돌려 호스트 커널 syscall 표면을 대폭 축소하는 **실제 격리 경계**를 주고, **systrap 플랫폼은 KVM이 불필요**해 VM/Docker/`/dev/kvm` 없는 머신 어디서든 돈다. Modal 등이 이 티어로 신뢰 불가 코드를 호스팅한다.

## 스파이크 증거 (2026-07-20, privileged debian:12 컨테이너, runsc release-20260714)

| 검증 | 결과 |
|---|---|
| nested `runsc run --platform=systrap --network=none --ignore-cgroups` | ✅ 부팅·실행, 게스트 `/proc/version`이 gVisor 확인, **KVM 없이** |
| bind-mount 호스트 볼륨(OCI `mounts`)의 `runsc run` 간 영속 | ✅ 영속 + 호스트 가시 |
| `--overlay2=none` + 세션별 rootfs 디렉토리의 rootfs 쓰기 영속 | ✅ 호스트에 영속 |
| 기본(overlay2 미지정) rootfs 쓰기 | ❌ ephemeral (gVisor가 rootfs를 기본 overlay 처리 → 쓰기 소실) |

**함의:** 영속은 rootfs 직접 쓰기가 아니라 **(a) bind-mount 볼륨** 또는 **(b) `--overlay2=none` + 세션별 rootfs**로 얻는다. host-uds(egress/auth 소켓)는 gVisor 공식 MAGI(2026-04)·FAQ의 `--host-uds` 근거로 뒷받침 — 빌드 시 socat 브리지로 실검증(테스트에 포함).

---

## File Structure

- **Create:** `packages/sandbox-server/src/gvisor-client.ts` — `GvisorSandboxClient` + 순수 함수 `buildOciConfig`, `runscRunArgs`.
- **Create:** `packages/sandbox-server/src/__tests__/gvisor-client.test.ts` — 순수 함수 단위 테스트(항상 실행) + runsc-present 통합 테스트(runsc 없으면 skip).
- **Modify:** `packages/sandbox-server/src/index.ts` — `GvisorSandboxClient` + 타입 export.
- **Modify:** `agent-sandbox/src/main.ts` — `SANDBOX_BACKEND=gvisor` 분기.
- **Modify:** `packages/sandbox-server/README.md`, `docs/architecture/packages-map.md` — gvisor backend 추가.
- `OverlayRootfsSandboxClient`가 참조 템플릿 — 구조/네이밍/테스트 패턴을 그대로 미러한다.

---

## Components & Interfaces

### 1. `buildOciConfig` (순수 함수 — `buildBwrapArgs`의 아날로그)

```ts
export interface GvisorSpecBase {
  sessionRootfsDir: string;      // 세션별 writable rootfs (base 이미지에서 시딩됨)
  workspaceDir: string;          // 호스트 워크스페이스 (bind 볼륨으로 /home/agent 에 마운트)
  network: 'none' | 'proxy';     // 'share'는 gVisor에서 미지원(격리 목적 위배) — 제외
  egressSocketPath?: string;     // network 'proxy': 호스트 egress 프록시 유닉스소켓
  authGatewaySocketPath?: string;// claude auth-injecting gateway 유닉스소켓
  capDrops?: readonly string[];  // OCI process.capabilities에서 제거
}
// 반환: OCI runtime spec(config.json) 객체. I/O 없음(테스트 표면 계약).
export function buildOciConfig(base: GvisorSpecBase, cmd: { argv: string[]; cwd: string }): OciConfig;
```

- workspace를 OCI `mounts`에 `{destination:'/home/agent', source: workspaceDir, type:'bind', options:['rbind','rw']}`로 넣는다(스파이크 Q3a 검증됨).
- egress/auth 소켓을 `mounts`의 bind로 `/run/nexora/egress.sock`·`/run/nexora/gateway.sock`에 넣고, `process.args`를 기존 socat loopback 브리지 런처(`loopbackBridgeScript` 재사용/이식)로 감싼다. `HTTPS_PROXY`·`ANTHROPIC_BASE_URL`을 `process.env`에 주입 — bwrap `buildBwrapArgs`의 proxy 분기와 동일 의미론.
- `process.args = cmd.argv`, `process.cwd = cmd.cwd`(기본 `/home/agent`).
- `root = { path: sessionRootfsDir, readonly: false }`.

### 2. `runscRunArgs` (순수 함수)

```ts
export function runscRunArgs(bundleDir: string, id: string): string[];
// → ['--platform=systrap','--network=none','--overlay2=none','--ignore-cgroups',
//    '--host-uds=open', '-bundle', bundleDir, 'run', id]  (network 'proxy'일 때 --host-uds 포함)
```

### 3. `GvisorSandboxClient implements SandboxClient`

```ts
export interface GvisorOptions {
  convDir: string;               // 세션별 상태 루트 (named volume; overlayfs 위 금지)
  baseRootfsDir: string;         // RO base 이미지 루트 (세션 rootfs 시딩 원본)
  network?: 'none' | 'proxy';    // 기본 'none'
  egressSocketPath?: string;     // 'proxy' 필수
  capDrops?: readonly string[];
  runscPath?: string;            // 기본 'runsc'
}
class GvisorSandboxClient {
  create(options?: WorkspaceAcquireOptions): Promise<WorkspaceSession>;  // SandboxClient
  attach(key: string): Promise<WorkspaceSession | null>;                 // DurableDirStore thaw용(관례)
  delete(session: WorkspaceSession): Promise<void>;                       // no-op (디스크가 archive)
  selfCheck(): Promise<void>;                                             // 실제 runsc run 1회, 실패 시 throw
}
```

- `create`: 세션 dir 생성 → `baseRootfsDir`를 세션 rootfs로 시딩(reflink/hardlink cp; 실패 시 일반 cp) → workspace dir 준비 → `seedInto`(기존 로직) → `WorkspaceSession` 반환.
- `WorkspaceSession`: `OverlayRootfsSandboxClient.makeSession`을 미러. `root='/home/agent'`, `hostRoot=workspaceDir`(persist/hydrate tar가 host backing을 읽음), `resolve()`는 in-jail 경로→host backing 매핑(기존과 동일), `run(cmd)`는 OCI config.json+rootfs 준비 후 `spawnCollect(runscPath, runscRunArgs(...), cmd)`.
- `run`은 **exec마다 fresh `runsc run`**(현행 spawn-per-exec 모델 유지). 세션 rootfs는 `--overlay2=none`로 host에 영속 → 설치물이 대화 수명 동안 유지(스파이크 검증).
- `spawnCollect`(stdout/stderr 수집·timeout·abort)는 **기존 함수 재사용** — export 하거나 공유 모듈로 이동.

### 4. 재사용(무변경)

`createSandboxServer`, `SessionRegistry`, `DurableDirStore`, `TarArchiveStore`, `startEgressProxy`, `startAuthInjectingGateway`. persist/hydrate/reattach/delete는 서버층이 `hostRoot`/`resolve()`로 처리하므로 backend 교체와 무관.

---

## Rootfs & 영속 모델

- **세션별 writable rootfs** = `baseRootfsDir`(도구 사전설치 이미지)에서 시딩된 host 디렉토리. `--overlay2=none`로 gVisor가 이 디렉토리에 직접 쓰게 해 rootfs 변경(pip/apt 설치)이 대화 수명 동안 영속.
- **워크스페이스** = host 디렉토리를 OCI bind 볼륨으로 `/home/agent`에 마운트 → fs-wire/seed/resolve가 기존 overlay backend와 동일하게 동작.
- **트레이드오프(정직):** `--overlay2=none`은 세션마다 rootfs 전체 사본 → 디스크 비용. 완화: 시딩을 reflink(CoW, `cp --reflink=auto`)/hardlink로. base 이미지가 도구를 충분히 담으면 세션 설치가 최소화돼 사본 diff도 작다.

## 네트워크 / egress / auth-gateway

- gVisor `--network=none`(netstack 비활성, 외부 경로 없음) + host-uds 브리지가 **유일한 egress**.
- egress 프록시·auth 게이트웨이 **호스트 유닉스소켓**을 OCI bind로 잽에 넣고 `--host-uds=open`으로 통과. 잽 안 socat이 loopback→소켓으로 포워딩(bwrap과 동일 패턴). allowlist 집행은 호스트측 프록시.
- claude OAuth 토큰은 잽에 파일로 안 들어가고 대화별 in-memory 게이트웨이에만 존재(기존 `auth-gateway` 그대로) — **gVisor 공식 MAGI가 독립적으로 권고한 "크리덴셜을 코어 샌드박스 밖에 두고 egress에서 주입" 패턴과 동일**.

## 보안 자세 & 잔여 리스크

- **얻는 것:** 호스트 커널 syscall 표면 대폭 축소(Sentry 유저스페이스 커널). ADR-002 위협(신뢰 불가 에이전트 코드)에 대한 실제 경계.
- **잔여 리스크(정직):** (1) Sentry 자체 버그·side-channel — 하드웨어 경계 아님. (2) 서버가 도는 **privileged 컨테이너**(nested runsc 요건) — 이 컨테이너 자체 탈출은 별개 신뢰 경계. (3) host-uds로 뚫은 소켓 2개가 유일한 host 접점(공격면 최소화됨).
- **하드웨어 티어**(Kata/Firecracker, KVM 필요)는 "진짜 적대적 멀티테넌트 호스팅"이 필요해질 때의 **별도 backend**(deferred). agent-sandbox의 Windows HCS VM 트랙이 그 방향.

## 배포

- `SANDBOX_BACKEND=gvisor` → `main.ts`가 `GvisorSandboxClient` 구성(+`convNet==='proxy'`면 egress 프록시 공유, 기존과 동일), `selfCheck()` 게이트 후 `createSandboxServer`에 주입.
- 이미지에 `runsc` 바이너리 설치(공식 릴리스). 컨테이너는 **privileged(또는 최소 SYS_ADMIN + seccomp unconfined)** 필요 — 스파이크에서 nested systrap 부팅 요건으로 확인. `main.ts`에 요건 문서화.
- `baseRootfsDir`는 nexora-agents 이미지 세트(agent-sandbox Dockerfile)와 정합.

## Testing 전략

- **순수 함수 테스트(항상 실행):** `buildOciConfig`가 workspace bind·소켓 bind·env·args·caps를 올바른 OCI로 만든다; `runscRunArgs` 플래그. (`buildBwrapArgs` 테스트 패턴 미러.)
- **통합 테스트(runsc 있으면):** `selfCheck` 성공; 2회 `run`에서 설치물 영속(`--overlay2=none`); network 'proxy'에서 host-uds+socat 브리지로 allowlist egress만 통과 + auth 게이트웨이 loopback 도달. **runsc 부재 시 skip**(CI 게이트는 Linux+runsc 잡).
- **적합성:** 기존 `RemoteSandboxClient` 적합성 하네스로 wire 동작 회귀 확인(backend 무관).

---

## Decision Log

- **D1 — 격리 커널 = gVisor(systrap), buy not build.** 이유: KVM 없이 어디서든 + 신뢰 불가 코드에 충분한 경계. bwrap은 위생일 뿐 경계 아님. Kata/Firecracker는 KVM 티어로 deferred.
- **D2 — A1′(raw `runsc run`) 채택, A2(containerd/Docker+`--runtime=runsc`) 기각.** 8차원 분석(현 구조 적합성/운영 TCB/테스트/feasibility에서 A1 우세; rootfs/생태계에서 A2 우세) 후, A2의 유일 강점(이미지 rootfs)을 **이미지-기반 rootfs + `--overlay2=none`**로 흡수(A1′). 데몬 의존 없이 spawn-per-exec 모델·재사용 표면 최대 유지. K8s 스케일이 필요해지면 seam 뒤에서 agent-sandbox로 교체 가능(nexora 무변경).
- **D3 — 영속 = bind 볼륨(workspace) + `--overlay2=none`(세션 rootfs).** 스파이크가 기본 rootfs 쓰기는 ephemeral임을 확인. host overlay 마운트는 컨테이너 overlay 위 nesting으로 실패 → 불채택.
- **D4 — 세션 rootfs 사본은 reflink/hardlink 시딩으로 완화.** RO-base 공유 CoW(overlay)는 gVisor에서 신뢰성 낮음.
- **D5 — auth-gateway 패턴 유지.** 크리덴셜을 잽 밖에 두고 egress 주입 — gVisor 공식 MAGI가 같은 결론.

## Out of Scope / Deferred

- Kata/Firecracker 하드웨어(KVM) 티어 backend.
- snapshot-fork(웜 세션 포크) via runsc `checkpoint`/`restore` — 후속.
- kubernetes-sigs/agent-sandbox 채택(K8s warm-pool/스냅샷) — 스케일 단계.

## Related Changes (별도 태스크)

- **microvm-sandbox(Python) park/retire** — `createSandboxServer` 재구현이라 중복. README 포인터 + 미커밋 Dockerfile/compose 제거.
- **ADR 추가(`plan/adrs/`)** — ADR-002 정정: *isolation = commodity buy(gVisor/runsc), moat 아님. moat = auth-injecting gateway(크리덴셜 잽 밖) + egress allowlist + wire 계약 + 런타임.* 외부 검증으로 MAGI 인용.
