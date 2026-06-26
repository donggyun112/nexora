# @dongkseo/context

**Stability: stable** · `pnpm add @dongkseo/context`

> 이 파일은 에이전트(사람·LLM)가 **소스를 열지 않고도** 이 패키지를 쓸 수 있게 하는 오리엔테이션 문서다.
> 정확한 API 타입은 "API 표면" 섹션의 방법으로 `signatures`만 읽어라 — 본문을 베끼지 말 것.

## 무엇인가 / 무엇이 아닌가

에이전트를 실행하기 전에 **컨텍스트(시스템 프롬프트)를 조립**하는 로더 패키지다. 디스크의
컨텍스트 디렉터리(`personas/`, `skills/`, `tenants/{tenantId}/` …)를 읽어 공통 컨텍스트 +
페르소나 + 스킬 메뉴 + 런타임 정보 + 테넌트 설정을 하나의 시스템 프롬프트로 합친다.

- ✅ 담는 것: 페르소나 로딩, 스킬 메뉴 생성, 테넌트별 설정/한도/도구 병합, 시스템 프롬프트 조립, 런타임 컨텍스트 수집
- ❌ 안 담는 것: 에이전트 실행 루프, LLM 호출, 도구 실행, 저장소 구현 — 그건 `core`/`pi-ai`/`adapters`/`store-*` 몫

의존 방향은 **context → contracts** 단방향. 타입은 `@dongkseo/contracts`에서만 가져온다.

## 핵심 개념

| 개념 | 무엇 | 대표 export |
| --- | --- | --- |
| **ContextLoader** | 모든 조각을 모아 `AgentContext`(시스템 프롬프트 포함)를 만드는 진입점 | `CoreContextLoader`, `ContextLoaderOptions` |
| **Persona** | 에이전트별 페르소나(`personas/{agent}.md`)를 읽고 캐시 | `PersonaLoader`, `PersonaLoaderOptions` |
| **Skills** | `skills/`를 스캔해 frontmatter 기반 스킬 메뉴 텍스트 생성 | `SkillLoader`, `SkillEntry`, `SkillLoaderOptions` |
| **Tenant** | 테넌트별 설정·한도·허용 도구를 읽고 기본값과 병합 | `TenantConfigStore`, `TenantConfig`, `DEFAULT_LIMITS` |
| **Runtime** | 작업 디렉터리 등 실행 환경 정보 수집 | `currentRuntime` |

## 사용 레시피

전체 컨텍스트 로더를 만들고 시스템 프롬프트를 조립한다 (`platform/cli/src/dev.ts` 기준, 실제 동작 코드):

```ts
import { CoreContextLoader } from '@dongkseo/context';

const contextLoader = new CoreContextLoader({
  root: contextDir,                                  // personas/ · skills/ · tenants/ 가 있는 루트
  defaultTools: ['read', 'grep', 'write', 'edit'],   // 테넌트 허용 도구가 없을 때 기본값
  workdirBase: process.cwd(),
});

// tenantId + agentName 으로 AgentContext(시스템 프롬프트·도구 목록 포함)를 만든다
const ctx = await contextLoader.load('default', 'coder');
```

개별 로더만 쓰고 싶을 때:

```ts
import { PersonaLoader, SkillLoader, TenantConfigStore, currentRuntime } from '@dongkseo/context';

const persona = new PersonaLoader({ root: 'context' }).load('coder');               // 페르소나 마크다운
const menu    = new SkillLoader({ root: 'context' }).buildMenu();                   // "## Available Skills…" 텍스트
const limits  = new TenantConfigStore({ root: 'context' }).mergedLimits('default'); // 기본+테넌트 병합 한도
const runtime = currentRuntime(process.cwd());                                      // 런타임 컨텍스트
```

더 큰 예제: [`platform/cli/src/dev.ts`](../../platform/cli/src/dev.ts) (로컬 개발 부트스트랩에서 로더 사용).

## API 표면 (소스 안 열고 타입만)

`index.ts`는 모듈별로 그룹핑돼 있고 파일 맨 위에 **섹션 맵 주석**이 있다. 정확한 시그니처가 필요하면
구현 본문 대신 **signatures 모드**로만 읽어라:

```bash
ctx_read(path="packages/context/src/loader.ts",  mode="signatures")
ctx_read(path="packages/context/src/persona.ts", mode="signatures")
ctx_read(path="packages/context/src/skills.ts",  mode="signatures")
ctx_read(path="packages/context/src/tenant.ts",  mode="signatures")
ctx_read(path="packages/context/src/index.ts",   mode="map")   # 전체 export 목록
```

어떤 파일에 뭐가 있는지는 `src/index.ts` 상단 주석 맵을 먼저 보면 된다.

## 유지보수 (drift 방지)

- 이 README = **목적·개념·레시피** 만. 거의 안 변하므로 손으로 관리.
- **API 정본은 각 소스의 TSDoc** (`/** … */`). API가 바뀌면 코드 옆 TSDoc만 고치면 됨 — 여기 표는 복제하지 말 것.
- 새 모듈을 export하면 `index.ts` 상단 섹션 맵에 한 줄만 추가.

## Tests

```bash
cd packages/context && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
