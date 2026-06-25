# 워크스페이스 연속성 — snapshot 오케스트레이션 & conversation 바인딩 설계

- **날짜**: 2026-06-25
- **상태**: 설계 기록 (구현 대기) — draft
- **범위**: nexora framework — `packages/contracts`, `packages/core`, `packages/store-json`, `packages/store-pg`
- **선행 문서**: `docs/superpowers/specs/2026-06-24-runtime-isolation-adoption-design.md` (워크스페이스 수명 = 대화-단위 고정 root)
- **레퍼런스**: `references/openai-agents-python` (`src/agents/sandbox/**`, `src/agents/run_state.py`)

> 이 문서는 **조사 + 설계 기록**이다. 구현은 후속 작업으로 분리한다(브랜치 별도). 섹션 6의 데코레이터 안이 채택안.

---

## 1. 목표 / 비목표

### 목표
멀티턴 대화에서 에이전트 워크스페이스(파일시스템 상태)가 **턴 경계를 넘어 연속**되도록, 다음 두 갭을 메운다:

- **B. snapshot 오케스트레이션** — 턴 종료 시 `snapshot()`을 떠서 ref를 저장하고, 다음 턴 시작에 그 ref로 워크스페이스를 복원하는 주체를 만든다. 현재는 누구도 `snapshot()`을 부르지 않는다.
- **C. workspace ↔ conversation 바인딩** — snapshot ref를 `conversationId`로 키된 영속 store에 묶어, 같은 대화의 다음 턴이 자신의 워크스페이스를 되찾게 한다. 현재 transcript/대화 영속화 레이어 어디에도 워크스페이스 참조가 없다.

레퍼런스의 핵심 아이디어(`RunState._sandbox` = conversation과 같은 체크포인트에 워크스페이스 ref를 묶음 + resume 시 fingerprint로 hot/cold 자동 선택)를 nexora seam에 이식한다.

### 비목표 (Non-goals)
- **A. workspace provider의 prod 와이어링** — 이 repo의 example들은 `workspaceProvider` 없이 실행되지만, 실제 소비 프로젝트(in7 / ixpert)는 런타임에 provider를 사용한다. 코어에 B+C를 빌드하면 소비자가 그대로 받는다. → A는 본 작업 범위 밖.
- 증분/CoW 스냅샷(overlayfs, content-addressed) — `SnapshotBackend` 구현체 교체로 가능한 별개 축. 초기엔 full-tar(`LocalTarSnapshotBackend`) 유지.
- cross-host 마이그레이션 자체 — 데이터 모델은 지원하나(durable tar) 본 작업은 단일 호스트 연속성에 집중.
- transcript-system-of-record 변경 — transcript는 메시지 system of record로 그대로 두고, 워크스페이스는 **separate-but-linked**(같은 `conversationId`로 링크되는 별도 store)로 둔다.

---

## 2. 배경 (조사 결과)

### 2.1 영속화 축이 3개인데 상태가 제각각

| 축 | 영속화 대상 | 상태 | 근거 |
|---|---|---|---|
| ① Transcript (system of record) | user·assistant·tool_use·tool_result·image | ✅ ACTIVE | `contracts/src/transcript.ts` `TranscriptStore`; `store-json`/`store-pg` 구현; `core/src/transcript-memory.ts` `TranscriptMemoryProvider.getHistory` 재생 |
| ② Workspace keep (고정 root) | 파일시스템 (안 지움) | ⚠️ 빌드됐으나 코어 미adoption | `AsrtSandboxClient` 존재, but prod에서 runner에 `workspaceProvider` 미주입 |
| ③ Snapshot/resume (tar) | root 바이트 → fresh root 복원 | 💤 DORMANT (테스트 전용) | `.snapshot()`/`.resume()` prod 호출 0건 |

### 2.2 하네스는 snapshot을 부르지 않는다 (B 갭)
`packages/core/src/execution-harness.ts`:
- `execute()` 시작: `workspaceProvider.acquire({ baseWorkdir, input })` (≈ L104-116)
- `finally`: `workspace.cleanup()`만 호출 (≈ L263-267). **`snapshot()` 자동 호출 없음.**
- 즉 "이 턴 끝났는데 inline-root로 둘까(hot) / tar로 뜰까(cold) / 지울까"를 정하는 오케스트레이터가 코드에 부재. 셋 중 늘 cleanup만.

### 2.3 transcript/대화 영속화에 워크스페이스 참조가 없다 (C 갭)
- `TranscriptEntry`(`contracts/src/transcript.ts`)에 workspace/snapshot/sandbox/root 필드 없음.
- `SuspendedTurnState`(handraise 파킹, `contracts/src/suspended-turn.ts`)에도 워크스페이스 ref 없음 — `architectureHistory`, `envelope`, `resumedCallId`, `toolResult`, `resultTopic`만.
- 따라서 resume(대화 재개)은 **메시지 재생 전용**. `TranscriptMemoryProvider`의 history 재생은 기록된 `tool_use`/`tool_result`를 **stub으로 주입**할 뿐 tool을 **재실행하지 않음** → 파일시스템 부작용은 transcript로 복원 불가.

### 2.4 핵심 seam — conversationId는 생성자 바인딩
- `new TranscriptMemoryProvider(store, conversationId)` — conversationId가 **생성자에서 바인딩**됨 (`core/src/__tests__/transcript-memory.test.ts:26`).
- 즉 앱의 `createRuntime`가 conversationId(= `envelope.metadata.conversationId`)를 알고, per-conversation provider를 만들어 하네스에 넘긴다. **하네스 자체는 conversation-agnostic.**
- bootstrap 턴 루프(`core/src/bootstrap.ts:276-481` `handleMessage`): `context = contextLoader.load(...)` → `resultTopic` 계산 → `onSuspend` 와이어(L380-393) → `createRuntime({ context, envelope, onSuspend })`(L395) → `runtime.execute(input)`(L400). **워크스페이스도 이 seam(createRuntime)에서 주입 가능.**

---

## 3. 레퍼런스 분석 — openai-agents-python

조사 대상: `src/agents/sandbox/session/**`, `src/agents/run_state.py`, `src/agents/sandbox/snapshot.py`.

### 3.1 언제 snapshot? → 세션 `stop()`에서 자동 (턴 끝)
dormant 배관이 아니라 **세션 lifecycle이 트리거**. 종료 시 워크스페이스 전체를 tar 스트림으로 직렬화 → pluggable 백엔드(`LocalSnapshot` 디스크 tar / `RemoteSnapshot` 원격 / `NoopSnapshot` 테스트)로 넘김. nexora의 `SnapshotBackend`(noop/local-tar)와 동일 추상.

### 3.2 hot/cold = fingerprint로 동적 결정 (핵심)
keep이냐 zip이냐를 **정적 옵션으로 안 고른다.** resume 시점에 결정:

```
resume 시:
  live 워크스페이스의 SHA256 fingerprint 계산
  ↓ 저장된 snapshot_fingerprint와 비교
  ├ 일치  → restore 스킵, ephemeral manifest만 재적용   = HOT PATH (keep 효과)
  └ 불일치/없음 → tar 추출(pruned root, in-place)         = COLD PATH (zip 효과)
                  (symlink은 escape 방지 위해 맨 마지막)
```

`SandboxSessionState`에 `snapshot_fingerprint`, `workspace_root_ready` 필드가 그래서 존재(`sandbox_session_state.py:15-24`).
→ **keep은 별도 노브가 아니라 "restore가 스킵 가능했다"의 결과.** 모델은 하나(snapshot = durable source of truth), live root가 살아있고 안 변했으면 비싼 복원을 자동으로 건너뜀.

### 3.3 바인딩 = `RunState._sandbox` (단일 체크포인트)
- `run_state.py:275` — `_sandbox: dict[str, Any] | None`. `to_json()`이 top-level `"sandbox"` 키로 직렬화(≈ L772).
- 워크스페이스 snapshot(`SandboxSessionState.snapshot`)이 **대화 포인터(`conversation_id`, `previous_response_id`)와 같은 RunState 레코드에 함께** 박힘.
- 다음 턴: `SandboxRuntimeSessionManager`가 prior RunState 받아 `_sandbox["sessions_by_agent"][resume_key]` 룩업 → `client.resume(state)` rehydrate (`runtime_session_manager.py:218-248`, `320-330`; `result.py:118-122`).
- 구조: 메시지(Session) ⊥ 워크스페이스(SandboxSessionState) — **separate-but-linked**, turn 끝에서 같은 체크포인트로 원자적 영속화.

### 3.4 tar = full + exclusions + checksums, 복원 = in-place pruned root
증분 델타 아님. 전체 root(제외 패턴) + checksum(`util/checksums.py`, `util/tar_utils.py`). fingerprint가 redundant 복원을 막음. 복원은 fresh mkdtemp가 아니라 기존 root prune 후 in-place.

---

## 4. 갭 매핑 (nexora ↔ 레퍼런스)

| 우리가 식별한 갭 | 레퍼런스의 답 | 본 설계의 대응 |
|---|---|---|
| snapshot을 누가/언제 호출? (하네스는 cleanup만) | 세션 `stop()`이 자동 호출 | 데코레이터 `session.cleanup()`이 snapshot+persist 후 inner cleanup |
| hot/cold 결정 오케스트레이터 부재 | resume 시 fingerprint 비교 | `WorkspaceSnapshot.fingerprint` + `AsrtSandboxClient.resume()` 분기 |
| workspace↔transcript 미결합 | `RunState._sandbox` 임베드 | `WorkspaceStateStore`(conversationId 키) — separate-but-linked |
| snapshot ref 소유자 미정의 | RunState가 소유 | 데코레이터 provider가 소유, store에 영속 |
| keep vs snapshot "충돌" | 충돌 없음 — keep = restore 스킵의 결과 | fingerprint hot-path로 동일하게 흡수 |
| inline-root vs durable | `SnapshotBase` 다형성 + fingerprint | 기존 `SnapshotBackend`(noop/local-tar) 재사용 |

**이미 가진 것**: `WorkspaceSnapshot{backend,ref,root}` ≈ `SnapshotBase`, `SnapshotBackend` ≈ 백엔드 추상, inline-root vs tar ≈ hot/cold. **데이터 모델은 거의 동형.**
**없는 것 (= RunState 등가물)**: ① turn 끝 snapshot 트리거 + ref 저장 오케스트레이터, ② ref를 담을 conversationId-키 store, ③ resume 시 fingerprint 정합성 체크.

---

## 5. 스코프 결정

- 채택: **B + C 코어 메커니즘** — dormant 배관을 "실제 작동하는 테스트된 서브시스템"으로 승격.
- A(prod 와이어링)는 소비 프로젝트가 이미 수행 → 범위 밖.
- 오케스트레이션 위치: **데코레이터 provider** (대안: 하네스 내장 / bootstrap 와이어링 — 모두 기각). 사유: 하네스 불변, `TranscriptMemoryProvider(store, convId)` 바인딩과 완전 동형, cross-turn 상태를 한 곳에 가둠.

---

## 6. 설계 — 데코레이터 provider

### 6.1 아키텍처

```
createRuntime (앱, conversationId 앎)
   │  new TranscriptMemoryProvider(transcriptStore, convId)            ← 기존 패턴
   │  new ContinuousWorkspaceProvider(sandboxClient, wsStateStore, convId)  ← 신규, 동형
   ▼
AgentRunner / LocalExecutionHarness   (변경 없음 — provider.acquire()/session.cleanup()만 호출)
   │
   ├ acquire() → [데코레이터] wsStateStore.load(convId)
   │              ├ snapshot 있음 → sandboxClient.resume(snapshot)   (fingerprint hot/cold 내부)
   │              └ 없음          → sandboxClient.acquire(options)
   │             → 반환 세션의 cleanup()을 persist-wrapping
   │
   └ session.cleanup() → [데코레이터] session.snapshot() → wsStateStore.save(convId, snap) → inner.cleanup()
```

**경계 원칙**: 데코레이터는 `WorkspaceProvider`(하네스가 보는 인터페이스)를 구현하되 inner로 `SandboxClient & WorkspaceProvider`(= `AsrtSandboxClient`, resume 보유)를 요구. 하네스는 데코레이터인지 raw provider인지 **모름** — 완전 투명.

### 6.2 컴포넌트

신규 파일:
| 파일 | 책임 |
|---|---|
| `packages/contracts/src/workspace-state.ts` | `WorkspaceStateStore` 계약 |
| `packages/core/src/continuous-workspace-provider.ts` | 데코레이터 — resume-or-acquire + snapshot-on-cleanup |
| `packages/store-json/src/workspace-state.ts` | JSON 파일 백엔드 (TranscriptStore 구현과 병렬) |
| `packages/store-pg/src/workspace-state.ts` | Postgres 백엔드 (병렬) |

변경 파일:
- `packages/contracts/src/workspace.ts` — `WorkspaceSnapshot`에 `fingerprint?: string` 추가
- `packages/core/src/asrt-sandbox-client.ts` — `snapshot()`에 fingerprint 계산, `resume()`에 hot/cold 분기
- `packages/core/src/workspace-snapshot.ts` — `fingerprintRoot(dir): Promise<string>` SHA256 헬퍼 추가
- `packages/contracts/src/index.ts`, `packages/core/src/index.ts` — export 추가

### 6.3 데이터 모델 (설계 스케치)

```ts
// contracts/src/workspace.ts (변경)
export interface WorkspaceSnapshot {
  id: string;
  backend: string;            // 'inline-root' | 'local-tar' | ...
  ref?: string;               // durable backend의 restore locator
  root?: string;              // live root (still on disk → fast-path 재사용)
  createdAt?: string;
  fingerprint?: string;       // ★ 신규: snapshot 시점 root의 SHA256 (hot/cold 판정용)
  metadata?: Record<string, unknown>;
}

// contracts/src/workspace-state.ts (신규)
export interface WorkspaceStateStore {
  load(conversationId: string): Promise<WorkspaceSnapshot | null>;
  save(conversationId: string, snapshot: WorkspaceSnapshot): Promise<void>;
  delete(conversationId: string): Promise<void>;
}
```

- **separate-but-linked**: transcript와 다른 store지만 같은 `conversationId`로 링크 (레퍼런스의 separate-but-linked와 동일 철학; 단 레퍼런스는 RunState 한 레코드에 임베드, 우리는 별도 store로 분리해 transcript 브랜치와 비결합 유지).
- 대화당 **최신 snapshot 1개**만 유지(덮어쓰기). 히스토리/롤백은 비목표.

### 6.4 제어 흐름 (설계 스케치)

```ts
// core/src/continuous-workspace-provider.ts (신규)
export class ContinuousWorkspaceProvider implements WorkspaceProvider {
  constructor(
    private readonly inner: SandboxClient & WorkspaceProvider,  // AsrtSandboxClient
    private readonly store: WorkspaceStateStore,
    private readonly conversationId: string,
  ) {}

  async acquire(options: WorkspaceAcquireOptions = {}): Promise<WorkspaceSession> {
    const prior = await this.store.load(this.conversationId);
    const session = prior
      ? await this.inner.resume(prior)          // fingerprint hot/cold 내부
      : await this.inner.acquire(options);
    return this.wrapCleanup(session);
  }

  private wrapCleanup(session: WorkspaceSession): WorkspaceSession {
    const store = this.store, convId = this.conversationId;
    const origCleanup = session.cleanup.bind(session);
    return new Proxy(session, {
      get(t, p, r) {
        if (p === 'cleanup') return async () => {
          try {
            const snap = await session.snapshot?.();
            if (snap) await store.save(convId, snap);   // best-effort
          } catch (e) { /* log, swallow — cleanup은 계속 */ }
          await origCleanup();
        };
        return Reflect.get(t, p, r);
      },
    });
  }
}
```
> 구현 시 Proxy 대신 명시적 래퍼 클래스가 더 명료할 수 있음 — 구현 단계에서 결정.

fingerprint hot/cold (`AsrtSandboxClient`):
```ts
async resume(state: WorkspaceSnapshot): Promise<WorkspaceSession> {
  const id = state.id || randomUUID();
  const root = this.perRun
    ? await this.createRunRoot(id)                 // fresh mkdtemp → 늘 cold
    : await this.resolveExistingRoot(state.root);  // 고정 root → hot 가능
  if (state.ref && (await this.snapshotBackend.restorable(state.ref))) {
    const live = !this.perRun ? await fingerprintRoot(root) : undefined;
    if (live !== undefined && live === state.fingerprint) {
      // HOT: 고정 root가 살아있고 마지막 snapshot 이후 안 변함 → restore 스킵
    } else {
      await this.snapshotBackend.restore(state.ref, root);  // COLD
    }
  }
  return this.buildSession(id, root);
}
```

- **hot-path가 지배하는 경우**: 소비자가 `perRun:false` + `cleanup:'keep'`(2026-06-24 도입 결정, 대화-단위 고정 root)로 운영하면 같은 호스트 연속 턴에서 live root가 fingerprint-match → restore 스킵. snapshot은 "호스트 손실/tmpdir 증발 대비 안전망"으로만 작동.
- **cold-path**: `perRun:true`(fresh mkdtemp)이거나 fingerprint 불일치(외부에서 root 변경 / 다른 호스트) → tar 복원.

### 6.5 suspend/resume 워크스페이스 갭도 닫힘 (공짜)
handraise로 턴이 suspend되면 하네스 `finally`가 여전히 `cleanup()`을 부른다 → 데코레이터가 snapshot+persist. 재개 턴의 `createRuntime`가 같은 convId로 `ContinuousWorkspaceProvider`를 만들면 `acquire()`가 prior snapshot을 복원. → **현재 "suspend 사이 중간 파일 증발" 문제가 자동 해소.** (별도 `SuspendedTurnState` 필드 추가 불필요 — 링크 키가 conversationId로 일원화되므로.)

---

## 7. 에러 처리 / 엣지 케이스

- **snapshot 실패** (디스크 부족 등): best-effort. 로그 후 swallow, `cleanup()`은 계속 진행. 다음 턴은 직전 성공 snapshot(또는 fresh)로 복원 — 데이터 무결성보다 가용성 우선(레퍼런스도 stop()에서 best-effort).
- **store.load 실패 / 손상 ref**: `restorable(ref)`가 false면 fresh acquire로 폴백. 절대 throw로 턴을 죽이지 않음.
- **턴 에러/abort 시 snapshot 여부**: cleanup은 항상 호출되므로 snapshot도 항상 시도. 부분 상태가 저장될 수 있으나, 부분 진행을 보존하는 편이 통째 손실보다 낫다(YAGNI: "성공 턴만 snapshot" 최적화는 후속).
- **동시성**: 같은 conversationId의 턴이 직렬화된다고 가정(in7 사용 패턴). 병렬 턴이 같은 root를 다투는 케이스는 비목표 — 필요 시 store에 낙관적 락(updatedAt CAS) 추가.
- **fingerprint 비용**: 대형 워크스페이스에서 전체 SHA256는 비쌈. 초기엔 단순 구현, 후속에서 mtime/size 기반 경량 fingerprint 또는 제외 패턴(.git, node_modules) 적용 검토. (열린 결정 9.2)

---

## 8. 테스트 계획 (TDD)

기존 `asrt-sandbox-client.test.ts`(snapshot→resume into fresh root)와 `workspace-snapshot.test.ts`(persist/restore) 위에 추가:

1. **`continuous-workspace-provider.test.ts`** (신규, 코어):
   - `acquire()`가 prior snapshot 없으면 `inner.acquire()` 호출, 세션 반환.
   - 턴1 `cleanup()` → store에 snapshot 저장됨. 턴2 `acquire()` → `inner.resume(저장된 snapshot)` 호출.
   - 턴1에서 만든 파일이 턴2 워크스페이스에서 보임 (end-to-end 연속성, 원본 root 삭제 후에도 — cold path).
   - snapshot 실패해도 `cleanup()`이 throw하지 않음.
   - 손상/없는 ref → fresh acquire 폴백.
2. **fingerprint hot/cold** (`asrt-sandbox-client.test.ts` 확장):
   - `perRun:false` 고정 root + 변경 없음 → `resume()`이 `restore()` **스킵** (hot). 스파이로 호출 0회 검증.
   - root 변경 후 fingerprint 불일치 → `restore()` 호출 (cold).
   - `perRun:true` → 항상 cold restore.
3. **`workspace-state.test.ts`** (store-json / store-pg 각각):
   - `save`/`load` 라운드트립, `load`(미존재)→null, `delete`, 덮어쓰기(최신 1개) 의미.
4. **회귀**: `workspaceProvider` 미주입(데코레이터 미사용) 경로는 기존과 동일 — 하네스 테스트 전부 PASS.

---

## 9. 미결 결정 / 후속

- **9.1 fingerprint v1 포함 여부**: 본 설계는 포함(레퍼런스 동형). 만약 소비자가 전적으로 `perRun:false`+keep로만 운영하면 live root 재사용이 지배적이라 fingerprint 없이도 동작 — 다만 tmpdir 증발/cross-host 안전망이 사라진다. → **포함 권장**, 단 경량 fingerprint(9.2)와 함께.
- **9.2 fingerprint 알고리즘**: 전체 SHA256(정확, 비쌈) vs mtime+size 다이제스트(저렴, 약함) vs 제외 패턴 적용. 구현 단계에서 워크스페이스 크기 가정에 맞춰 결정.
- **9.3 store 백엔드 범위**: json + pg 둘 다 vs json(또는 in-memory)만 먼저. TranscriptStore가 둘 다 가지므로 대칭 위해 둘 다 권장하나, pg는 후속 가능.
- **9.4 retention/cleanup**: conversation 종료 시 `WorkspaceStateStore.delete` + 백엔드 tar GC 정책(미정). TTL sweep은 별도.
- **9.5 증분/CoW snapshot**: `SnapshotBackend` 구현체 교체로 가능한 별개 축. 본 작업은 full-tar.

---

## 10. 부록 — 핵심 file:line 인덱스

조사 시점 기준(라인은 드리프트 가능):

**nexora (현재 상태)**
- `packages/core/src/execution-harness.ts` — acquire ≈L104-116, cleanup(finally) ≈L263-267 (snapshot 미호출)
- `packages/core/src/workspace-provider.ts` — `HostWorkspaceProvider`, `snapshot()` inline-root ≈L128
- `packages/core/src/asrt-sandbox-client.ts` — `resume()` ≈L133-141, `snapshot()` ≈L280-296, perRun/cleanup 기본값 ≈L92-95
- `packages/core/src/workspace-snapshot.ts` — `NoopSnapshotBackend`, `LocalTarSnapshotBackend`(persist/restore/restorable)
- `packages/contracts/src/workspace.ts` — `WorkspaceSnapshot`, `SnapshotBackend`, `WorkspaceSession`, `WorkspaceProvider`, `SandboxClient`
- `packages/core/src/bootstrap.ts` — `handleMessage` L276-481, `onSuspend` L380-393, `createRuntime` 옵션 L57-66
- `packages/core/src/transcript-memory.ts` — `TranscriptMemoryProvider(store, conversationId)`
- `packages/contracts/src/transcript.ts` — `TranscriptStore` (workspace 참조 없음)
- `packages/contracts/src/suspended-turn.ts` — `SuspendedTurnState` (workspace 참조 없음)

**레퍼런스 (openai-agents-python)**
- `src/agents/run_state.py:275` — `_sandbox: dict | None`; `to_json` ≈L772
- `src/agents/sandbox/session/sandbox_session_state.py:15-24` — `SandboxSessionState{ snapshot, snapshot_fingerprint, workspace_root_ready }`
- `src/agents/sandbox/session/runtime_session_manager.py:218-248` — `serialize_resume_state`; `320-330` — `client.resume`
- `src/agents/sandbox/session/snapshot_lifecycle.py`, `sandbox_session.py` — stop() 트리거 + fingerprint
- `src/agents/sandbox/snapshot.py` — `LocalSnapshot` / `RemoteSnapshot` / `NoopSnapshot`
- `src/agents/result.py:118-122` — `state._sandbox = sandbox_resume_state`
