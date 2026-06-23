# @dongkseo/tenancy

**Stability: experimental** · `pnpm add @dongkseo/tenancy`

> 이 파일은 에이전트(사람·LLM)가 **소스를 열지 않고도** 이 패키지를 쓸 수 있게 하는 오리엔테이션 문서다.
> 정확한 API 타입은 "API 표면" 섹션의 방법으로 `signatures`만 읽어라 — 본문을 베끼지 말 것.

## 무엇인가 / 무엇이 아닌가

Nexora의 **opt-in 멀티테넌시** 패키지다. 프레임워크 코어는 테넌트를 모른다 — 테넌트 id가 없으면
모든 것이 단일 테넌트(`DEFAULT_TENANT`)로 동작하고, 어떤 코드도 테넌트 개념을 들고 다니지 않는다.
하나의 배포 뒤에서 여러 테넌트를 격리해야 할 때만 이 패키지를 import 한다. 그러면 그 격리에 필요한
**리졸버 + 테넌트별 config + 예산 스코프**가 한 곳에서 묶여 온다.

- ✅ 담는 것: HTTP 요청에서 테넌트를 뽑는 리졸버(`headerTenantResolver`), 테넌트 예산 스코프 팩토리
  (`tenantBudgetScope`, `tenantAgentBudgetScope`), 그리고 테넌트별 config/스코프 진입점 re-export
- ❌ 안 담는 것: 실행 엔진, 예산 집행 로직, ContextLoader 구현, LLM 호출 — 그건 `core`/`context` 몫
- 의존 방향: **app → tenancy → contracts/context** 단방향. 코어는 tenancy를 모른다(반대 방향 의존 없음).

설계 배경은 `docs/architecture/adrs/adr-001-tenancy-opt-in.md` 참고.

## 핵심 개념

| 개념 | 무엇 | 대표 export |
| --- | --- | --- |
| **Tenant resolver** | 인바운드 HTTP 요청에서 테넌트 id를 뽑는 함수 (어댑터의 `resolveTenant`에 꽂음) | `headerTenantResolver`, `TenantResolver` |
| **Budget scope** | 예산 정책이 적용될 범위(테넌트 / 테넌트+에이전트) 식별자 | `tenantBudgetScope`, `tenantAgentBudgetScope`, `BudgetScope` |
| **Tenant config** | 테넌트별 페르소나·limits·도구 화이트리스트 저장소 (ContextLoader가 소비) | `TenantConfigStore`, `TenantConfig`, `DEFAULT_LIMITS` |
| **Default tenant** | tenancy를 안 깔았을 때 쓰이는 단일 테넌트 id | `DEFAULT_TENANT` |

> `TenantConfigStore`/`DEFAULT_LIMITS`/`DEFAULT_TENANT`/`BudgetScope`는 사이클을 피하려고 물리적으로
> `@dongkseo/context`·`@dongkseo/contracts`에 있지만, **tenancy가 단일 opt-in 진입점**이 되도록 여기서 re-export 한다.

## 사용 레시피

HTTP 어댑터에 테넌트 리졸버와 테넌트 config를 꽂아 멀티테넌시를 켠다 (소스 TSDoc 기준, 실제 동작 코드):

```ts
import { headerTenantResolver, TenantConfigStore } from '@dongkseo/tenancy';

const http = new HttpAdapter({ resolveTenant: headerTenantResolver('x-tenant-id') });
const contextLoader = new CoreContextLoader({ tenants: new TenantConfigStore({ root }) });
```

헤더가 없거나 비어 있으면 `DEFAULT_TENANT`로 폴백한다. 커스텀 헤더명도 받는다:

```ts
import { headerTenantResolver } from '@dongkseo/tenancy';

const resolve = headerTenantResolver('x-org');
resolve(req); // req.headers['x-org'] 값, 없으면 DEFAULT_TENANT
```

예산 정책에 넘길 스코프를 만든다:

```ts
import { tenantBudgetScope, tenantAgentBudgetScope } from '@dongkseo/tenancy';

tenantBudgetScope('acme');                 // { type: 'tenant', tenantId: 'acme' }
tenantAgentBudgetScope('acme', 'coder');   // { type: 'tenant-agent', tenantId: 'acme', agentName: 'coder' }
```

## API 표면 (소스 안 열고 타입만)

`index.ts` 맨 위에 **섹션 맵 주석**이 있어 어떤 export가 어느 파일에서 오는지 보인다. 정확한 시그니처가
필요하면 구현 본문 대신 **signatures 모드**로만 읽어라:

```
ctx_read(path="packages/tenancy/src/resolver.ts", mode="signatures")
ctx_read(path="packages/tenancy/src/budget.ts",   mode="signatures")
ctx_read(path="packages/tenancy/src/index.ts",    mode="map")   # 전체 export 목록 + 섹션 맵
```

re-export된 `TenantConfigStore`/`TenantConfig`/`DEFAULT_LIMITS`의 정본은 `@dongkseo/context`의 `src/tenant.ts`,
`BudgetScope`/`DEFAULT_TENANT`는 `@dongkseo/contracts`에 있다.

## 유지보수 (drift 방지)

- 이 README = **목적·개념·레시피** 만. 거의 안 변하므로 손으로 관리.
- **API 정본은 각 소스의 TSDoc** (`/** … */`). API가 바뀌면 코드 옆 TSDoc만 고치면 됨 — 여기 표는 복제하지 말 것.
- 새 모듈을 export하면 `index.ts` 상단 섹션 맵에 한 줄만 추가.

## Tests

```bash
cd packages/tenancy && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework.
