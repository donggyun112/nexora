# Workspace Seed Dirs — auto-materialize support dirs on workspace acquire

**상태**: Draft
**날짜**: 2026-07-01
**범위**: `@dongkseo/contracts`, `@dongkseo/core`
**소비자**: `document-agent`, `ixpert_manager`, `in7-marketing-poc` (3개 Multica consumer 전부)

## 컨텍스트

세 Multica consumer(`document-agent`, `ixpert_manager`, `in7-marketing-poc`)는 전부 같은 태스크
spawn 모델을 쓴다 — Multica 데몬이 태스크마다 `PI_SPAWN_CWD`라는 워크dir 하나만 주고 프로세스를
띄운다(자동 checkout 없음, `document-agent/src/pi-cli.ts:14-15`, `ixpert_manager/src/runtime/compose.ts`
헤더 주석에 동일 문구). 에이전트의 `read`/`exec` 도구는 이 워크dir(정확히는 대화별로 스코핑된
`<workdir>/.sandbox/<convId>`)에 바인딩된다.

Multica는 별도로 `.pi/skills/<name>/SKILL.md`(+ `references/`, `scripts/`)를 스킬로 주입하는데, 이
주입 위치가 에이전트의 워크dir 밖일 수 있다. `in7-marketing-poc`는 이미 이 문제를 한 번 겪고
고쳤다 — `68cc57d fix(multica): mirror skills into workspace` 커밋으로 `src/runtime/skill-workspace-mirror.ts`를
추가해, 워크스페이스 생성 시 스킬 소스 디렉토리들을 워크dir 안으로 복사(mirror)했다. 그런데 이
수정은 in7 앱 코드 안에만 있어서, 동일한 Multica 모델을 쓰는 `document-agent`/`ixpert_manager`는
아직 이 문제를 안 겪었을 뿐(아직 실사용 스킬이 없어서) 그대로 노출돼 있다.

**최초 오해 정정**: 처음엔 `createSandboxProvider`의 OS 샌드박스가 워크dir 밖 파일 읽기를 막는다고
가정했으나, `sandbox-provider.ts`의 정책 주석은 "읽기는 넓게, 비밀 경로만 차단"이라 이 가설은
틀렸다. 실제 원인은 Multica의 spawn-cwd 모델 — 워크dir 밖의 파일은 애초에 그 태스크 프로세스의
파일시스템 뷰에 없을 수 있다(seatbelt 읽기 정책과 무관한, 상위의 spawn/마운트 경계 문제).

세 앱이 각자 이 로직을 베끼는 대신, "워크스페이스가 만들어질 때 필요한 디렉토리를 자동으로
같이 심는다"는 걸 워크스페이스 lifecycle 자체의 기능으로 nexora에 올린다. 단, 프레임워크
경계 원칙(`docs/architecture/adrs/adr-001-tenancy-opt-in.md`가 확립한 "core는 메커니즘, 앱은
정책")을 지킨다 — "무엇을 심을지"(스킬 소스 토폴로지)는 계속 앱이 결정하고, "언제/어떻게
심는지"(워크스페이스 획득 시 자동 복사)만 nexora가 가진다.

## 결정

`WorkspaceProvider.acquire()`에 `seedDirs` 옵션을 추가해, 워크스페이스 root가 정해진 직후·세션을
반환하기 전에 지정된 디렉토리들을 자동으로 복사해 넣는다. 앱은 이 필드에 "무엇을 심을지"만
넘기고, 별도의 미러링 함수 호출을 잊어버릴 걱정이 없다 — 워크스페이스 활성화 자체에 내장된 동작.

### 1. `@dongkseo/contracts` — `WorkspaceAcquireOptions` 확장

`packages/contracts/src/workspace.ts:110-115`:

```ts
export interface WorkspaceAcquireOptions {
  baseWorkdir?: string;
  runId?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  /** 워크스페이스 root가 정해진 직후 자동으로 복사해 넣을 디렉토리들. 소스가 없거나
   *  읽기 실패해도 acquire 자체는 실패하지 않는다(best-effort). 심볼릭 링크는 스킵. */
  seedDirs?: ReadonlyArray<{ source: string; destSubpath: string }>;
}
```

### 2. `@dongkseo/core` — acquire 호출부 + provider 구현

- `execution-harness.ts`의 `this.workspaceProvider.acquire({ baseWorkdir: ... })` 호출에
  `seedDirs: this.workspaceSeedDirs`를 추가. `LocalExecutionHarnessOptions`(=`AgentRunnerOptions`)에
  대응 필드 `workspaceSeedDirs?: WorkspaceAcquireOptions['seedDirs']` 추가 — 앱이
  `new AgentRunner({ ..., workspaceSeedDirs })`로 대화별 값을 넘긴다(지금 `runtimeSkillsDir`가
  `createRuntime()` 호출마다 envelope에서 resolve되는 것과 같은 타이밍).
- `HostWorkspaceProvider.acquire()`와 샌드박스 provider(`AsrtSandboxClient`, `sandbox-provider.ts`가
  감싸는 실제 구현)의 acquire 경로에 공통 `materializeSeedDirs(root, seedDirs)` 헬퍼를 추가 —
  `cpSync(source, path.join(root, destSubpath), { recursive: true, force: true, filter: skip symlinks })`.
  소스가 디렉토리가 아니면(없음/파일) 조용히 skip.
- `ContinuousWorkspaceProvider`(대화 연속성 래퍼)는 `acquire(options)`을 그대로 내부 provider에
  pass-through 하므로 별도 수정 없이 `seedDirs`가 통과한다. **명시 결정**: resume 경로(이전
  snapshot 존재)에서도 매 `acquire()`마다 다시 seed한다 — 스킬 소스가 대화 중간에 갱신될 수
  있으므로, "최초 1회만 seed"는 stale 스킬을 반환할 위험이 있다. 재복사 비용은 디렉토리 크기가
  작아(SKILL.md + 소수 reference/scripts) 매 턴 감내 가능한 수준.

### 3. 소비 앱 — "무엇을 심을지" 결정은 그대로 앱 소유

- `in7-marketing-poc`: 기존 `src/runtime/skill-workspace-mirror.ts`의 3-소스 로직
  (`agentSkillsDir`/`sharedSkillsDir`/`runtimeSkillsDir` → `.skill_refs/agents/<owner>/skills`,
  `.skill_refs/runtime/skills`)을 `seedDirs` 배열 빌드로 교체하고 파일은 삭제. `build-runtime.ts`가
  `AgentRunner` 생성 시 `workspaceSeedDirs`로 넘긴다.
- `ixpert_manager`: `runtimeSkillsDir` 하나만 `seedDirs: [{source: runtimeSkillsDir, destSubpath: '.skill_refs/runtime/skills'}]`로 넘긴다. 동시에 `skill_manage`(`src/tools/skill.tool.ts`)와
  `buildRuntimeSkillReferenceMenu`가 원본 `runtimeSkillsDir` 대신 미러링된 경로를 보게 전환.
- `document-agent`: `ixpert_manager`의 `skill.tool.ts` 패턴을 그대로 가져와 `skill_manage`를
  신규 도입(현재는 아예 없음) + 동일하게 `runtimeSkillsDir` 하나만 seed. `compose.ts`가 이미
  받고 무시하던 `runtimeSkillsDir` 파라미터를 실제로 배선.

## 에러 처리

- 소스 디렉토리가 없거나(`ENOENT`) 읽기 실패해도 `acquire()` 자체는 성공해야 한다 — 스킬이 없어도
  에이전트는 정상 동작해야 하므로 best-effort. 기존 in7 `mirrorDir`의
  `if (!isDirectory(source)) return source;` 패턴을 계승.
- 심볼릭 링크는 복사하지 않는다(기존 in7 구현과 동일 — 워크스페이스 밖을 다시 가리키는 링크가
  샌드박스 경계를 무력화하지 않도록).

## 테스트

- nexora: `HostWorkspaceProvider`/샌드박스 provider의 `acquire()`에 대한 유닛테스트 — `seedDirs`
  지정 시 파일이 실제 워크dir 안에 나타나는지, 심볼릭 링크가 스킵되는지, 소스 없을 때
  acquire가 실패하지 않는지.
- 각 소비 앱: `pnpm run lint`(tsc --noEmit) + `pnpm test`로 배선 확인. `ixpert_manager`/
  `in7-marketing-poc`는 skill_manage 관련 기존 테스트가 있으면 새 경로(미러링된 디렉토리)
  기준으로 갱신.

## 롤아웃 순서

1. nexora: `contracts`(`seedDirs` 타입) + `core`(acquire 호출부·provider 구현) 수정, 유닛테스트,
   버전 릴리즈(publish).
2. `ixpert_manager`: `@dongkseo/core`/`@dongkseo/contracts` 버전 bump → `seedDirs` 배선 +
   `skill.tool.ts`가 미러링된 경로를 보도록 전환.
3. `document-agent`: 버전 bump → `skill_manage` 신규 도입(ixpert 패턴 이식) + `seedDirs` 배선.
4. `in7-marketing-poc`: 버전 bump → 기존 `skill-workspace-mirror.ts` 제거하고 `seedDirs`로 교체.

각 단계는 독립적으로 검증 가능(레포별 `pnpm install && pnpm run lint && pnpm test`) — 순서를
바꿔도 무방하나 위 순서가 "가장 단순한 소비자 먼저" 원칙에 맞는다.

## 참고

- 근거 커밋: `in7-marketing-poc` `68cc57d fix(multica): mirror skills into workspace`
- 관련 ADR: [adr-001-tenancy-opt-in.md](../../architecture/adrs/adr-001-tenancy-opt-in.md) — "core는
  메커니즘, 앱은 정책" 원칙의 선례.
- 관련 설계: [2026-06-24-runtime-isolation-adoption-design.md](./2026-06-24-runtime-isolation-adoption-design.md) — 샌드박스 provider의 읽기/쓰기 정책 정본.
