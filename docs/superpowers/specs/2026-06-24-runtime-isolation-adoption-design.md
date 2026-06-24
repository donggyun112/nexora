# 런타임 격리 도입 — in7 / ixpert 설계 스펙

- **날짜**: 2026-06-24
- **상태**: 설계 승인 대기 (draft)
- **범위**: nexora (framework), in7-marketing-poc, ixpert_manager (3-repo 조정 작업)
- **대상 OS**: macOS 전용 (seatbelt / `sandbox-exec`)

---

## 1. 목표

nexora의 런타임 격리 기능(WorkspaceSession / ExecutionHarness / SandboxClient)을 두 소비 프로젝트에 도입하되, **목적은 제약이 아니라 개방**이다. OS 샌드박스가 실질 경계를 잡아주므로 `exec`/`bash`/`grep` 등 강력한(원래 위험한) 도구를 에이전트에게 **자유롭게** 열어준다.

### 비목표 (Non-goals)
- 자원 고갈(DoS) 방어 — seatbelt 범위 밖 (exec 타임아웃/출력 캡 + 필요 시 호스트 `ulimit`로 별도 완화)
- 커널 익스플로잇 방어 — OS 샌드박스 공통 한계 (VM 아님)
- Linux/Windows 지원 — 현재 macOS 전용
- 기존 도메인 기능(이미지 파이프라인, Jira/Confluence/Excel 등) 변경 — **구현 레이어만 교체**, 동작은 보존

---

## 2. 배경 (조사 결과)

### 2.1 격리 메커니즘은 이미 nexora에 존재
- `ToolContext`에 `workspace?: WorkspaceSession` 필드 ("Active workspace boundary for file/process tools").
- `LocalExecutionHarness`에 `workspaceProvider?` 옵션. `execute()` 시작에 `acquire()`, 툴 컨텍스트에 `{ workdir: session.root, workspace }` 주입, `finally`에서 `cleanup()` (`packages/core/src/execution-harness.ts:114-243`).
- `CoreToolExecutor`는 `withContext()`/`getContext()` 지원 → 주입 호환 (`packages/core/src/tool-executor.ts:68-78`).
- `AgentRunnerOptions = LocalExecutionHarnessOptions` → `new AgentRunner({ …, workspaceProvider })` 가 진입점.

### 2.2 빌트인 도구가 이미 샌드박스-인지
`@dongkseo/tools`가 `create{Read,Grep,Write,Edit,Exec,Knowledge}Tool` 제공. read/grep/write/edit는 `ctx.workspace.resolve()/run()` 소비, `createExecTool`은 하드닝된 임의 명령 실행(argv[0] traversal 차단, 인터프리터 탐지, `allowedExecutables` 옵션, 120s 타임아웃, 256KB 출력 캡). → **열려는 도구가 전부 이미 존재하고 세션-인지.**

### 2.3 워크스페이스 수명 = run 단위 (핵심 발견)
하니스의 acquire/cleanup는 `execute()`(= inbound 메시지 1건 처리, ReAct 루프 전체) 단위. 즉 기본 동작은 **턴마다 워크스페이스 휘발**. 멀티턴 대화에서 유저는 동일 워크스페이스를 기대하므로 이건 불일치.

이는 **OS 격리 때문이 아니라 워크스페이스 provider의 수명 정책 때문**이다 (두 레이어는 직교):
- `AsrtSandboxClient.create()`는 매 acquire마다 `mkdtemp` (`asrt-sandbox-client.ts:109`) → 휘발.
- `HostWorkspaceProvider(perRun:false)`는 `resolveExistingRoot(baseWorkdir)`로 고정 root 재사용 → 영속. 단 Host는 `run()`/OS 샌드박스 없음 (`workspace-provider.ts:56-82`).
- `cleanup()`은 `cleanupMode==='delete'`일 때만 `rm`.

→ "강한 샌드박스 + 세션 영속"을 동시에 얻으려면 asrt에 고정-root 모드가 필요 (현재 비대칭).

### 2.4 macOS seatbelt 격리의 성격과 한계
- **커널 강제(MAC, TrustedBSD)** — 앱 권한 아님. 거부는 syscall 단 EPERM, 프로세스 트리 전체 상속. 임의 서브프로세스도 차단.
- 집행: 파일 쓰기 allow-only(워크스페이스만), 읽기 deny-then-allow, 네트워크 allow-only(localhost 프록시), unix 소켓 기본 차단, mandatory-deny(`.zshrc`/`.git/hooks` 등 항상 차단).
- **한계 (정직)**: 네임스페이스/마운트 격리 없음(컨테이너/VM 아님, 호스트 FS·프로세스·커널 공유), 자원 제한 없음, 읽기 기본 넓음, `allowAppleEvents`/넓은 도메인/unix 소켓 허용 시 탈출 벡터. **베타 리서치 프리뷰**.
- 호스트 prereq: `ripgrep` 설치 필요 (`brew install ripgrep`).

### 2.5 두 소비 프로젝트 현황
- **공통**: `AgentRunner` + `CoreToolExecutor` + 정적 `ToolContext.workdir`(문자열). 격리 계약 참조 0건. 각자 자체 가드 + 서브프로세스 spawn.
- **in7**: file-io 4종(`checkPath` 금지목록 + `scopeFileTool`로 `.scratch/shared` 스코핑), `humanize_metrics`(python3 spawn), 7 피어 에이전트가 `.scratch/shared` 파일명 규약 + 로컬 `ImageArtifactStore`(`src/runtime/image-artifact-store.ts`)로 산출물 공유.
- **ixpert**: `read`(벤더링 `safe-path.ts` O_NOFOLLOW), `excel`/`knowledge`(fs 쓰기), `multica`(execFile spawn), Jira/Confluence(in-process HTTP — 샌드박스 밖). 교차-에이전트 파일 공유 요구 약함.

---

## 3. 아키텍처 — 3레이어 분리

### 레이어 ① OS 격리
`AsrtSandboxClient`(macOS seatbelt). 정책 기본값(보안 모델):
- `mode: 'workspace-write'` — 워크스페이스 root만 쓰기 허용.
- `denyRead: ['~/.ssh', 자격증명/비밀 경로]`.
- `allowedDomains`: 최소 화이트리스트 (예: npm/git 레지스트리). 빈 배열이면 네트워크 전면 차단.
- `allowAppleEvents: false`, `enableWeakerNetworkIsolation: false`, 넓은 `allowUnixSockets` 금지.
- exec: 빌트인 캡(120s/256KB) 사용, `allowedExecutables`는 기본 미지정(전체 허용) — "자유 개방" 목표에 따름.

### 레이어 ② 워크스페이스 수명 — 대화 단위 영속
- **nexora 변경**: `AsrtSandboxClient`에 `HostWorkspaceProvider.perRun`과 대칭인 **고정-root 모드** 추가. `perRun:false`(또는 명시 `root`/`baseWorkdir` 사용) 시 `mkdtemp` 대신 호출자가 준 root 재사용. `cleanupMode` 기본 `'keep'` 옵션으로 디렉토리 보존(샌드박스 해제만 수행).
- 소비자는 `ToolContext.workdir = <base>/<conversationId>` 로 설정 (in7: `envelope.metadata.conversationId`, ixpert: scope). 같은 대화의 모든 턴이 동일 root.
- 정리: 대화 종료/유휴 시 TTL 스윕 (in7의 기존 `.scratch` 6h 스윕 패턴 일반화).

### 레이어 ③ 에이전트 간 공유 — 아티팩트 채널 (로컬 파일 공유 폐기)
- 로컬 파일 기반 공유(`.scratch/shared` 규약, 로컬 `ImageArtifactStore`)는 **제거**.
- **nexora 승격**: conversationId 키 아티팩트 채널을 nexora `Store` backbone(store-json/store-pg) 위에 신설. publish(ref 반환) / fetch(ref → bytes) / TTL.
- 모델: producer 에이전트가 자기 샌드박스에서 작업 → 산출물을 채널에 publish → ref를 메시지로 전달 → consumer가 ref로 fetch → 필요 시 자기 샌드박스로 materialize.
- 이점: 격리 유지(에이전트는 자기 워크스페이스만), 명시적 계약, 감사 가능, 프로세스/머신 경계 무관. 파일명 규약 결합 제거.

---

## 4. 컴포넌트별 설계

### 4.1 nexora — AsrtSandboxClient 고정-root 모드
- `AsrtSandboxClientOptions`에 `perRun?: boolean`(기본 true, 기존 호환) + `root?: string` 추가. `cleanupMode` 기본은 호출 측에서 `'keep'` 선택 가능.
- `create()`: `perRun===false`면 `root ?? options.baseWorkdir`를 mkdir -p + realpath 후 재사용; 아니면 기존 `mkdtemp`.
- 테스트: 동일 root 재사용 시 파일 영속, `cleanup:'keep'`이 rm 안 함, seatbelt 정책이 root 기준 동일 생성됨.

### 4.2 nexora — 아티팩트 채널
- `ArtifactChannel` 계약: `publish(scope, name, bytes|stream, meta) → ref`, `fetch(ref) → bytes`, `list(scope)`, TTL/cleanup.
- store-json / store-pg 백엔드 구현. scope = conversationId(또는 tenant+conversation).
- 빌트인 도구(선택): `share_artifact` / `get_artifact` (에이전트가 명시적으로 주고받을 때).

### 4.3 공유 도입 패턴 (각 소비 프로젝트가 import)
- `createSandboxProvider(opts)` — 레이어 ① 정책 + 레이어 ② 고정-root를 묶은 팩토리.
- 빌트인 도구 등록 묶음 — `create{Exec,Grep,Read,Write,Edit}Tool`.
- (nexora examples 또는 각 프로젝트 로컬 헬퍼 — 4.6에서 결정)

### 4.4 in7 도입
- `buildRuntime()`에서 `AgentRunner({ …, workspaceProvider: createSandboxProvider(...) })` 배선, `workdir`를 conversationId 스코프로.
- **제거**: `checkPath`/`scopeFileTool`(file-io), `.scratch/shared` 공유, 로컬 `ImageArtifactStore` 구현.
- **전환**: file-io 4종 → 빌트인 read/write/edit/grep; `humanize_metrics` → 빌트인 exec(`ctx.workspace.run` python3); 이미지/슬라이드/레퍼런스 공유 → 아티팩트 채널.
- **동시성**: 7 피어 에이전트 + 다중 스레드 동시 실행 ↔ 전역 `SandboxManager` — §5 검증 항목.

### 4.5 ixpert 도입
- `main.ts`에서 동일 배선. `workdir`를 scope/conversation 스코프로.
- **제거**: 벤더링 `safe-path.ts`(read.tool가 빌트인 read 전환 시).
- **전환**: `read` → 빌트인 read; `excel`/`knowledge` 파일 I/O는 워크스페이스 root 기준으로 정렬(`ctx.workspace.resolve`); `multica` → 빌트인 exec(`allowedExecutables`로 `multica`만 허용하거나 기존 arg allowlist 유지). Jira/Confluence는 in-process HTTP라 샌드박스 무관(문서화).

### 4.6 결정 사항
- 아티팩트 채널 위치: **nexora 승격** (두 프로젝트 공통). 승인됨.
- 도입 헬퍼 위치: nexora examples vs 각 프로젝트 로컬 — 플랜에서 확정.

---

## 5. 리스크 & 미해결 (플랜 단계 필수 검증)

1. **전역 `SandboxManager` 동시성 (최우선)**: `ensureSandboxManagerInitialized`/`SandboxManager.cleanupAfterCommand()`가 정적/싱글톤으로 보임. in7의 동시 다중 대화(서로 다른 root/정책)에서 경합·정책 오염 가능. 대책 후보: per-command 격리 확인, 직렬화, 또는 세션별 매니저 인스턴스화 가능 여부 확인. **이 검증 없이는 in7 적용 불가.**

   **동시성 검증 결과(2026-06-24, Task2)**: 특성화 테스트(`packages/core/src/__tests__/asrt-sandbox-concurrency.test.ts`, 2 PASS) + SDK `@anthropic-ai/sandbox-runtime@0.0.59` 소스 독해로 확인. **FS 정책은 per-command 격리 성립** — `run()`이 세션별 config를 `wrapWithSandboxArgv(cmd, shell, this.config, signal)`로 전달하고, SDK `wrapWithSandbox`가 그 `customConfig.filesystem` 의 allow/deny 를 wrap 시점에 seatbelt 프로파일로 굽는다(SDK `updateConfig` 주석: "Filesystem changes are NOT applied live; macOS bakes them into the seatbelt profile at wrap time"). 따라서 동시 다른-root 세션 간 파일 격리는 전역 config 교체와 **무관하게** 유지된다. **단 네트워크는 전역 공유**: 프록시와 `config`는 module-level 싱글톤으로 `initialize` 1회 기동되고 `config.network.allowedDomains/deniedDomains`를 per-request로 읽는다. 고정-root(`perRun:false`)에서 sandboxing 이 이미 enabled 면 두 번째 이후 `create()`가 `ensureSandboxManagerInitialized → updateConfig(config)`로 **전역 네트워크 정책을 live-swap**(실행 중인 모든 sandbox 자식에 즉시 반영)한다. → 동시 대화가 **동일 네트워크 allowlist를 공유**하며, 새 세션 acquire 가 in-flight 대화의 유효 네트워크 정책을 바꿀 수 있다. **in7 게이트 판정**: (a) 모든 대화에 공통 도메인 allowlist 를 쓰거나 (b) exec 네트워크를 끄는 선에서 안전. 대화별 상이 네트워크 정책은 현재 비지원 → 필요 시 세션별 매니저 인스턴스화 등 별도 과제.
2. macOS seatbelt 베타 프리뷰 — API 변동 가능성, 위반 시 디버깅 흐름.
3. `ripgrep` 호스트 prereq — 배포/개발 환경 보장.
4. exec 개방의 운영 안전 — 자원 고갈은 범위 밖이나 타임아웃/캡 + 모니터링 권장.
5. 아티팩트 채널 마이그레이션 — in7 이미지 파이프라인 동작 동치성 회귀 테스트 필요.

---

## 6. 단계화 (구현 순서)

- **Phase 0 (nexora 기반)**: AsrtSandboxClient 고정-root 모드 + 아티팩트 채널 + 테스트. **+ SandboxManager 동시성 검증 (게이트).**
- **Phase 1 (ixpert)**: 단순(교차-공유 요구 약함) → 도입 패턴 검증의 파일럿.
- **Phase 2 (in7)**: 복잡(피어 에이전트 공유 + 동시성). Phase 0 동시성 게이트 통과 전제.

---

## 7. 테스트 전략
- nexora: 고정-root 영속/정리, 아티팩트 채널 publish/fetch/TTL, 동시성 시나리오.
- 소비자: 빌트인 도구가 샌드박스 경계 안에서 동작(밖 쓰기/비밀 읽기/네트워크 차단 확인), 멀티턴 파일 영속, 이미지 파이프라인 회귀.
- `tsc --noEmit` + 기존 vitest 스위트 유지.
