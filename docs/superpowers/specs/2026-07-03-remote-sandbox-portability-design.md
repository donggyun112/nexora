# 원격/클라우드 sandbox 이식 — 포터빌리티 축 도입 설계

- **날짜**: 2026-07-03
- **상태**: 설계 승인 대기 (draft)
- **범위**: nexora (framework) — `@dongkseo/contracts` 확장 + 신규 `@dongkseo/sandbox-remote`(클라이언트) + 신규 `@dongkseo/sandbox-server`(참조 서버) + 로컬 아카이브 신뢰 경계
- **레퍼런스**: `references/openai-agents-python/src/agents/sandbox/**` (특히 `session/sandbox_client.py`, `extensions/sandbox/cloudflare/sandbox.py`, `util/tar_utils.py`, `session/archive_extraction.py`, `.agents/references/sandbox-runtime-boundary.md`)
- **선행 설계**: `2026-06-24-runtime-isolation-adoption-design.md`(로컬 OS 격리), `2026-06-25-workspace-continuity-design.md`(연속성)

---

## 1. 목표

openai-agents-python의 sandbox가 자랑하는 **포터빌리티 축**("같은 SandboxAgent, client만 바꿔 로컬↔컨테이너↔클라우드")을 Nexora에 충실히 흡수한다. 현재 Nexora는 이 축의 **로컬 절반만** 갖고 있다. 원격 절반(원격 backend, 원격 exec/fs, 원격 persist/hydrate, 살아있는 세션 reattach)을 추가하되, **provider-중립 wire 프로토콜을 Nexora가 정의하고 참조 서버를 자작**한다(특정 벤더 비결합).

### 비목표 (Non-goals)
- 특정 상용 provider(Cloudflare/Modal/E2B) 어댑터 — 중립 프로토콜을 먼저 세우고, 어댑터는 후속 과제(동일 계약에 drop-in).
- 클라우드 버킷 마운트(S3/R2/GCS) — 후속. 본 스펙의 manifest는 마운트 "선언" 자리만 마련한다.
- 참조 서버의 프로덕션 배포/오토스케일/멀티테넌트 쿼터 — 참조 서버는 프로토콜을 실증하는 최소 구현. 운영 강화는 후속.
- 커널 익스플로잇/DoS 방어 — OS 샌드박스 공통 한계(선행 설계 §1과 동일).
- Realtime/voice 등 sandbox 외 런타임 — 무관.

### 성공 기준
1. 동일 `SandboxAgent`/도구 배선에서 `workspaceProvider`만 `createSandboxProvider`(로컬)↔`RemoteSandboxClient`(원격)로 교체해도 read/grep/exec/write가 동작한다.
2. `resume`가 **살아있는 원격 세션에 reattach**(hot)하고, 원격 세션이 사라졌으면 **snapshot 바이트로 재생성+hydrate**(cold)한다 — 두 경로를 계약이 명시적으로 구분한다.
3. 아카이브 추출(snapshot restore + 원격 hydrate)이 zip-slip·symlink 탈출·hardlink·리소스 폭탄을 거부한다(자체 추출, TOCTOU 차단).
4. API 키/자격증명이 모델·로그·에러·직렬화 상태에 노출되지 않는다.

---

## 2. 배경 — 흡수 현황 (조사 결과)

| openai 개념 | Nexora 현황 | 판정 |
|---|---|---|
| `BaseSandboxClient`(create/delete/resume/deserialize) | `SandboxClient`(create/resume/delete) `contracts/workspace.ts` | ✅ 모양 흡수 |
| 로컬 OS 격리 backend | `AsrtSandboxClient`(seatbelt+bwrap+네트워크 allowlist+비밀 denylist) | ✅ 흡수(더 성숙) |
| 워크스페이스 경로 jail | `resolvePathAgainstRoot` `contracts/canonical-path.ts` | ✅ 흡수 |
| snapshot persist/restore + 상태 store | `LocalTarSnapshotBackend` + `WorkspaceStateStore` + `ContinuousWorkspaceProvider` | ✅ 흡수 |
| **여러 pluggable backend**(local↔docker↔cloud) | ASRT(로컬)+Host(무격리) 둘뿐 | ❌ 미흡수 |
| **원격/클라우드 backend**(HTTP/SSE/WS exec, 원격 provisioning) | 전무 | ❌ 미흡수 |
| **원격 reattach resume**(`resume(SandboxSessionState)` → 살아있는 원격 id로 재접속) | `resume(WorkspaceSnapshot)` = 스냅샷 바이트 재수화만 | ❌ 미흡수(개념 상이) |
| 통합 `manifest`(마운트+파일시딩을 데이터로 create에 전달) | `WorkspaceMount` + `seedDirs` 분산 | ⚠️ 부분 |
| 아카이브 추출 신뢰 경계 | `restore`가 무검증 `tar -xf`; `materializeSeedDirs` dest 미검증 | ❌ 미흡수 |

**핵심 판별점**: openai는 *session state*(원격 backend 재접속용 연결 상태)와 *snapshot*(워크스페이스 바이트)을 명확히 구분한다(`sandbox-runtime-boundary.md` "Session Source and Saved State"). Nexora의 `resume`는 후자만 안다 → 로컬 전용 설계의 결정적 신호. 원격 이식의 뼈대는 이 구분을 계약에 도입하는 것이다.

---

## 3. 아키텍처 — 4개 작업 축

```
① contracts 확장   SandboxSessionState / Manifest / resume 이원화 / wire DTO
      │  (모든 패키지가 여기로 수렴 — 역방향 import 금지)
      ▼
② safe-archive     자체 tar 추출(검증+O_NOFOLLOW+symlink-last+한도). contracts에 배치.
      │            로컬 restore + 원격 hydrate 양쪽이 소비.
      ▼
③ sandbox-remote   RemoteSandboxClient: SandboxClient/WorkspaceSession을 wire로 구현.
   (신규 패키지)    create(provision)/run(exec)/read·write(fs)/snapshot(persist)/
      │            resume(reattach|hydrate)/delete. contracts만 의존.
      ▼
④ sandbox-server   참조 서버: wire 프로토콜을 노출. 서버 측 OS 격리는 core의
   (신규 패키지)    AsrtSandboxSession(또는 컨테이너) 재사용. 어셈블리 계층이라 core 의존 허용.
```

### 3.1 계층/의존 방향
- `contracts`: 타입 + 순수/파일 헬퍼(`canonical-path.ts` 선례) → **safe-archive.ts, session-state/manifest/wire DTO를 여기 둔다.**
- `sandbox-remote` → `contracts`만 의존(클라이언트는 서버 구현을 몰라야 함).
- `sandbox-server` → `contracts` + `core`(ASRT 세션 재사용). 어셈블리 계층이므로 아래를 의존해도 규칙 위반 아님(gateway가 adapters/registry 의존하는 것과 동일).
- 기존 `core`의 로컬 backend/harness는 **불변**(원격은 추가지 교체 아님).

---

## 4. 컴포넌트별 설계

### 4.1 contracts 확장 (`packages/contracts/src`)

#### (a) session-state vs snapshot 이원화
```ts
// workspace.ts (확장)
export interface SandboxSessionState {
  /** 이 상태를 만든 backend 종류(예: 'remote', 'asrt', 'docker'). resume 라우팅 키. */
  backend: string;
  /** backend가 살아있는 원격 세션에 재접속할 때 쓰는 불투명 로케이터(예: 원격 sandboxId+endpoint). */
  ref?: string;
  /** 재접속 실패 시 재생성+hydrate에 쓸 워크스페이스 바이트 스냅샷. */
  snapshot?: WorkspaceSnapshot;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}
```
- `SandboxClient.resume`를 **`SandboxSessionState`를 받도록 이원화**. 기존 `resume(WorkspaceSnapshot)` 호출부(AsrtSandboxClient, ContinuousWorkspaceProvider)를 함께 이행한다.
  - 이행 방식: `resume(state: SandboxSessionState)`로 통일하고, "스냅샷만 있는" 로컬 경로는 `{ backend:'asrt', snapshot }`로 감싼다. `WorkspaceStateStore`는 `SandboxSessionState`(스냅샷 포함)를 저장하도록 확장. **호환 판단**: 이 계약은 Nexora 내부 소비자(core)만 쓰므로 직접 교체 + 회귀 테스트로 처리(외부 published 소비자 없음 — 확인 필요, §5-6).
- `serialize/deserialize`: session-state는 JSON 왕복 가능해야 한다(원격 재접속 상태 영속). 자격증명은 **직렬화에 포함하지 않는다**(§4.4 보안).

#### (b) 통합 Manifest
```ts
export interface WorkspaceManifest {
  mounts?: WorkspaceMount[];
  /** 워크스페이스 root 기준 상대 목적지로만 시딩(탈출 금지, §4.2로 검증). */
  seed?: ReadonlyArray<{ source: string; destSubpath: string }>;
}
```
- `WorkspaceAcquireOptions`에 `manifest?: WorkspaceManifest` 추가(기존 `seedDirs`/mounts는 manifest로 흡수하되, 기존 필드는 append 유지 → 파괴적 변경 회피).
- manifest는 **fresh 세션에만** 적용(resume/reattach된 워크스페이스는 덮지 않음 — openai "Manifest ... seed only a fresh session").

#### (c) wire DTO
- `sandbox-protocol.ts`(신규): 요청/응답 타입(ExecRequest/ExecResult, FsRead/Write, PersistRef, CreateSession, ReattachResult 등)을 **contracts에 선언** → 클라이언트·서버가 동일 타입 공유. 순수 타입만.

### 4.2 safe-archive (`packages/contracts/src/safe-archive.ts`, 신규)

openai `util/tar_utils.py` + `session/archive_extraction.py`의 충실 이식. **무의존 순수 JS tar 파서 + 하드닝 추출기.**

- `ArchiveLimits { maxMembers?, maxExtractedBytes? }` (openai `SandboxArchiveLimits`).
- `parseTar(stream): AsyncIterable<TarMember>` — ustar + GNU longname('L') + PAX('x' path/size) 헤더 처리(GNU/bsdtar 산출물 커버). 스트리밍(전체 멤버 리스트 비적재).
- `validateMember(member)` — 절대경로·`..`·Windows 구분자/드라이브·hardlink·미지원 타입 거부; symlink는 허용하되 **부모 경로가 symlink를 관통하면 거부**, symlink 타깃이 root 밖으로 나가면 거부(openai `safe_tar_member_rel_path`/`validate_tarfile`/`_validate_symlink_target`).
- `safeExtractTar(stream, destRoot, limits)` — dir·file를 먼저 `open(O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW)`로 쓰고, **symlink는 전부 마지막에** 생성(openai `safe_extract_tarfile`). 멤버 수/바이트 한도 스트리밍 검사. 부모에 기존 symlink 있으면 거부.
- 대칭 writer `writeTar(rootDir): stream` — persist를 시스템 `tar`에서 **자작 writer로 교체**(양끝을 우리가 통제 → GNU tar 출력 파싱 취약성 제거, 시스템 `tar` 의존 탈피, "dependency-free" 철학 부합).

**소비처 교체:**
- `core/workspace-snapshot.ts` `LocalTarSnapshotBackend.persist/restore` → `writeTar`/`safeExtractTar`.
- `core/workspace-seed.ts` `materializeSeedDirs` → dest를 `resolvePathAgainstRoot(destSubpath, root)`로 검증(root 탈출 거부). source symlink 미추종은 유지.
- `sandbox-remote` hydrate(원격에서 받은 아카이브를 로컬 root로 풀 때, 그리고 서버가 업로드 받은 아카이브를 서버 root로 풀 때) → `safeExtractTar`.

### 4.3 wire 프로토콜 (HTTP + WS, provider-중립)

Cloudflare 백엔드 형태를 일반화. 전송은 Nexora 기존 HTTP 어댑터 위(§4.5). 인증은 `Authorization: Bearer <token>`(서버가 검증, 클라이언트가 어댑터에 보관).

| 엔드포인트 | 메서드 | 용도 | 스트리밍 |
|---|---|---|---|
| `POST /sessions` | HTTP | 세션 provision(manifest/snapshot seed) → `{sessionId, ref}` | - |
| `POST /sessions/:id/exec` | HTTP+SSE | 명령 실행, stdout/stderr/exit 스트림 | SSE |
| `GET  /sessions/:id/pty` | WS | 대화형 PTY(선택; v1은 exec만 필수) | WS |
| `GET  /sessions/:id/fs?path=` | HTTP | 파일 read(바이트) | chunked |
| `PUT  /sessions/:id/fs?path=` | HTTP | 파일 write(바이트) | chunked |
| `POST /sessions/:id/persist` | HTTP | 서버가 workspace를 tar로 스트림 반환 | chunked |
| `POST /sessions/:id/hydrate` | HTTP | tar 업로드 → 서버 root로 안전 추출 | chunked |
| `POST /sessions/:id/reattach` | HTTP | 살아있는지 확인 + 재바인딩 → `{alive}` | - |
| `DELETE /sessions/:id` | HTTP | 세션/자원 해제 | - |

- 경로 검증: 클라이언트가 POSIX 렉시컬 검증(root 밖 거부), **서버가 realpath로 재검증**(TOCTOU/symlink) — openai `_validate_path_access`. 서버가 최종 신뢰 경계.
- 에러: HTTP status→`{ code, message, retryable }` 정규화(openai retryability 명시). 민감 payload 비노출.

### 4.4 RemoteSandboxClient (`packages/sandbox-remote/src`, 신규)

`SandboxClient` + `WorkspaceProvider` 구현. 내부 `RemoteSandboxSession`은 `WorkspaceSession` 구현:
- `create(options)` → `POST /sessions`(manifest/snapshot) → 세션. `resolve()`는 **렉시컬 POSIX 검증**(원격 fs를 로컬 realpath 불가; openai `normalize_sandbox_path`) + write 시 서버 재검증.
- `run(command)` → `POST /exec`(SSE 수집) → `SandboxCommandResult`. `wrapCommand`는 **미제공(undefined)** — 원격은 서버가 격리하므로 "argv를 로컬에서 jail-wrap"이 무의미. exec 도구의 background 경로는 `wrapCommand` 없으면 비격리 폴백하는데, 원격에선 그 폴백이 호스트에서 도므로 **위험** → 원격 세션에서는 background exec를 서버측 background task로 라우팅하거나(후속) v1에서는 비활성(문서화 + 게이트).
- read/write → `/fs`.
- `snapshot()` → `POST /persist`로 tar 수신 → `SnapshotBackend`에 저장 → `WorkspaceSnapshot{backend:'remote', ref}`; **아울러 `sessionState()`**(신규, 선택적 세션 메서드)로 `{backend:'remote', ref:<sandboxId@endpoint>, snapshot}` 생산.
- `resume(state)` → `POST /reattach`(alive?) → 살아있으면 그 세션 재바인딩(HOT); 죽었으면 `create` 후 스냅샷 바이트를 `/hydrate`(COLD).
- `delete/cleanup` → `DELETE /sessions/:id`(+ 부분 시작 실패시 자원 정리).
- 보안: 토큰은 클라이언트 옵션/env에서만, `sessionState`/스냅샷/에러/로그에 미포함(§1-4).

### 4.5 참조 sandbox 서버 (`packages/sandbox-server/src`, 신규)

wire 프로토콜을 구현하는 최소 서버. Nexora `@dongkseo/adapters`의 HTTP 프리미티브 위에 라우트를 얹고, **세션 실행은 `core`의 `AsrtSandboxSession`(로컬 OS 격리) 재사용** — 즉 "원격 노드에서 도는 로컬 격리 세션"을 HTTP로 노출하는 형태. 컨테이너 격리는 후속(동일 라우트, 세션 구현만 교체).
- 세션 레지스트리(sessionId→살아있는 `WorkspaceSession`), TTL 스윕.
- `/exec`→`session.run`(SSE로 스트림), `/fs`→resolve+read/write, `/persist`→`writeTar(root)`, `/hydrate`→`safeExtractTar`, `/reattach`→레지스트리 조회.
- 인증 미들웨어(bearer), 요청당 경로 재검증.

### 4.6 배선/provider
- `createRemoteSandboxProvider({ endpoint, token, snapshotBackend, manifest })` — 로컬 `createSandboxProvider`와 대칭 팩토리. `ContinuousWorkspaceProvider`로 감싸 대화 연속성 동일 적용(단 저장 단위가 `SandboxSessionState`).
- 소비자는 `AgentRunner({ workspaceProvider })` 한 줄만 교체.

---

## 5. 리스크 & 미해결 (플랜 단계 필수)

1. **background exec 원격 안전(최우선 게이트)**: 원격 세션에 `wrapCommand`가 없으면 exec 도구의 `run_in_background`가 **호스트에서 비격리 spawn**된다(`exec.ts:392` 폴백). 원격 세션에서는 background를 (a) 서버측 task로 라우팅하거나 (b) 명시 비활성해야 한다. 이 결정 없이는 원격 배선 불가.
2. **계약 이원화 파급**: `resume(WorkspaceSnapshot)`→`resume(SandboxSessionState)`가 core 소비자(AsrtSandboxClient, ContinuousWorkspaceProvider, WorkspaceStateStore, store-json/pg)에 파급. published 외부 소비자 유무 확인(있으면 얇은 어댑터).
3. **tar 파서 견고성**: 자작 파서가 GNU/PAX 확장 헤더를 정확히 처리해야(특히 긴 경로/큰 파일). persist를 자작 writer로 함께 교체해 양끝 포맷을 통제하되, "외부에서 들어온 임의 tar"(hydrate 업로드)도 파싱 대상 → 방어적 파싱 + 퍼즈성 테스트.
4. **참조 서버 위치/배포**: 어셈블리 패키지가 core 의존 → 순환 없음 확인. 서버는 예제 수준 배포(도커파일)만.
5. **SSE/WS 취소·타임아웃**: `ctx.signal` → HTTP abort 전파, 서버측 프로세스 kill 보장(openai `_exec_internal` cc=44 상당 복잡도 — 스트림/취소/에러 3경로 테스트).
6. **동시성**: 서버 세션 레지스트리 동시 접근, 로컬 ASRT 전역 매니저 네트워크 정책 공유(선행 설계 §5-1 결론 재확인 — 서버 프로세스 1개면 대화별 상이 네트워크 정책 비지원).

---

## 6. 단계화 (구현 순서)

- **Phase 0 — 로컬 신뢰 경계(선결, 독립 가치)**: `safe-archive.ts`(parser/validate/safeExtractTar/writeTar) + `LocalTarSnapshotBackend`·`materializeSeedDirs` 교체 + 테스트(zip-slip/symlink/hardlink/한도/왕복). 원격과 무관하게 즉시 방어 강화. **hydrate가 재사용할 토대.**
- **Phase 1 — 계약 이원화**: `SandboxSessionState`/`WorkspaceManifest`/wire DTO 추가, `resume` 이원화 + core 소비자 이행 + `WorkspaceStateStore` 확장 + 회귀 테스트. (§5-1 background 게이트 결정 포함.)
- **Phase 2 — 참조 서버**: `sandbox-server` 라우트(create/exec/fs/persist/hydrate/reattach/delete) + 인증 + 세션 레지스트리/TTL + 서버 단위 테스트(로컬 ASRT 세션 위).
- **Phase 3 — 원격 클라이언트**: `sandbox-remote` `RemoteSandboxClient`/`RemoteSandboxSession` + 팩토리 + 서버 상대 통합 테스트(create→exec→persist→resume(reattach)→resume(cold hydrate)→delete).
- **Phase 4 — 배선/문서**: `createRemoteSandboxProvider` + `ContinuousWorkspaceProvider` 연동 + packages-map/README + 예제(로컬↔원격 교체 1줄).

각 Phase는 TDD(테스트 선행) + `pnpm test`/`tsc --noEmit` 통과로 완료.

---

## 7. 테스트 전략
- **safe-archive**: zip-slip(`../`), 절대경로, symlink 부모 관통, symlink 타깃 탈출, hardlink, 미지원 타입, maxMembers/maxExtractedBytes 초과, writeTar↔safeExtractTar 왕복 무손실, 기존 스냅샷 왕복 회귀.
- **계약 이원화**: `resume(sessionState)` reattach-hot / cold-hydrate 분기, `WorkspaceStateStore` 왕복(json/pg), manifest fresh-only 적용.
- **참조 서버**: 각 라우트 성공/실패, 경로 재검증(root 탈출·symlink), 인증 거부, TTL 정리, exec 취소/타임아웃.
- **원격 클라이언트**: 서버 상대 end-to-end 격리 경계(밖 쓰기/비밀 읽기/네트워크 차단이 서버측에서 실제 차단), 재접속/재수화, 토큰 비노출(직렬화/로그 스냅샷 검사).
- **포터빌리티**: 동일 도구 스위트를 로컬 provider와 원격 provider 양쪽에서 실행해 동치 동작 확인.
- 전 구간 `make`류 대신 nexora 규약: `pnpm -r test` + `tsc --noEmit`.

---

## 8. 진행 기록 (2026-07-03 구현)

- **Phase 0 완료** — `packages/contracts/src/safe-archive.ts`(무의존 tar writer/parser + `safeExtractTar` O_NOFOLLOW·symlink-last + `ArchiveLimits`). `LocalTarSnapshotBackend` persist/restore를 시스템 `tar`에서 교체, `materializeSeedDirs` dest 탈출 검증 추가. 테스트: contracts safe-archive 12, 전체 contracts 86 / core 248 통과.
- **Phase 1 완료** — contracts에 `SandboxSessionState`(reattach ref + 임베드 snapshot) / `WorkspaceManifest` / `WorkspaceSession.sessionState()` 추가, `SandboxClient.resume`를 `SandboxSessionState`로 이원화. core(`AsrtSandboxClient.resume`+`sessionState()`, `ContinuousWorkspaceProvider`) + `WorkspaceStateStore`(store-json/pg) 이행. `ContinuousWorkspaceProvider`가 `sessionState()`를 우선 저장(원격 reattach ref 보존). 테스트: core 249, store-json 42 통과.
- **Phase 2 완료** — 신규 `@dongkseo/sandbox-server`: `createSandboxServer`(create/exec/fs/persist/hydrate/reattach/delete + bearer + 경로 재검증 403 + 정규화 에러 envelope). 실행은 주입식 `SandboxClient`에 위임(contracts만 의존). 테스트 5.
- **Phase 3 완료** — 신규 `@dongkseo/sandbox-remote`: `RemoteSandboxClient`(SandboxClient+WorkspaceProvider, create/run/snapshot/sessionState/resume reattach|hydrate/delete). 원격 세션은 `wrapCommand` 미제공(서버측 격리). 통합 테스트 6(서버 상대 create→exec→persist→reattach HOT→cold hydrate→delete, 토큰 강제, 경로 탈출 거부).
- **Phase 4 완료** — packages-map.md에 두 패키지 등재(capability/deps), 각 패키지 README. `RemoteSandboxClient`가 `ResumableWorkspaceProvider`를 만족해 `ContinuousWorkspaceProvider`에 무배선 주입됨(별도 팩토리 불필요).

### 남은 격차 (후속 과제)
1. **fs-over-wire 도구 통합 — ✅ 런타임-스왑 구조로 재설계(2026-07-03)**: 도구별 원격 분기(`if remote`)는 **틀린 레이어**였다. 대신 `WorkspaceFs`(readFile/writeFile(mode,atomic)/stat/readdir) 런타임 seam을 `@dongkseo/contracts`에 도입 — 도구(read/write/edit)는 이 인터페이스에만 의존하고 **backend를 모른다**. 로컬은 `LocalWorkspaceFs`(safe-path의 O_NOFOLLOW·atomic temp+rename·mode보존·jail 캡슐화, tools 패키지), 원격은 `RemoteSandboxSession.fs`(wire, 서버 `/fs`·`/stat`·`/readdir`). `workspaceFs(ctx)`가 활성 런타임을 고름(세션.fs 있으면 그것, 없으면 root 기준 LocalWorkspaceFs) — **로컬↔원격↔컨테이너 = 런타임 교체, 도구 코드 불변**. read-only 워크스페이스/마운트 강제는 세션 `resolve(access:'write')` 위임으로 보존. PDF는 바이트를 temp로 materialize해 렌더(로컬/원격 공통). 서버 `/fs` PUT은 O_NOFOLLOW.
   - **잔여**: `grep`은 아직 로컬 fs 직접 사용 → 같은 seam(fs.readdir+fs.readFile, 또는 서버측 search 엔드포인트)으로 전환 필요. 원격 edit 원자성/서버측 per-file 락, 원격 write의 mode 전달.
   - 배선 메모: `packages/tools`가 `@dongkseo/contracts`를 `^0.1.22`(published)로 핀해 새 필드가 로컬에서 안 보였음 → 나머지 전 패키지와 동일하게 `workspace:^`로 정렬(publish 시 concrete 버전 치환 → publish-safe).
2. **background exec 원격 안전(§5-1)** — 원격 세션에 `wrapCommand`가 없어 exec 도구의 `run_in_background`가 호스트 비격리 spawn으로 폴백. exec 도구가 원격/비-wrappable 세션에서 background를 거부하거나 서버측 task로 라우팅하도록 가드 필요.
3. **exec 스트리밍/PTY** — v1은 버퍼링 exec. 대화형/대용량은 SSE + WS PTY(프로토콜 자리 마련됨) 후속.
4. **상용 provider 어댑터 / 버킷 마운트** — 동일 계약에 drop-in.
5. **원격 스냅샷 내구성** — `RemoteSandboxClient`가 persist 바이트를 로컬 `spoolDir`에 스풀한다. 따라서 cold reattach는 **동일 호스트/프로세스에서만** 복구 가능하고, 스풀 파일은 자동 정리되지 않는다. 진짜 크로스-호스트 복구는 durable/shared byte store 주입이 필요(후속).
6. **서버 바디 상한** — `/hydrate`·`/fs` PUT이 요청 바디를 메모리로 전부 읽은 뒤 `archiveLimits`를 적용한다. 스트리밍 단계 상한(무제한 업로드 OOM 방지)은 후속 하드닝.

### 자기리뷰에서 잡아 수정한 결함 (2026-07-03)
- **tar 파서 PAX-size 비동기화(정확성, 수정됨)** — PAX `size` 확장 헤더로 파일 크기가 오면 데이터 헤더의 size 필드가 0이라, 파서가 파일 데이터 블록을 건너뛰지 못하고 다음 헤더를 파일 본문에서 읽어 붕괴. effective size 기준으로 오프셋을 전진하도록 수정 + 회귀 테스트(`stays in sync`).
- **PAX 레코드 길이 바이트 계산(정확성, 수정됨)** — 레코드 길이를 JS 문자열 길이로 계산해 비-ASCII 긴 경로의 외부 tar를 오파싱. writer/parser 모두 UTF-8 바이트 길이 기준으로 수정 + 비-ASCII 긴 경로 왕복 테스트.
- **manifest 미배선(완결성, 수정됨)** — `WorkspaceManifest`를 계약에 추가했으나 어떤 backend도 소비하지 않아 inert였음. `AsrtSandboxClient.create`가 fresh 세션에 `manifest.seed`/`mounts`를 적용하도록 배선 + 테스트.
