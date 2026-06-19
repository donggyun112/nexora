# ADR-001: Tenancy as an opt-in package

**상태**: Accepted (Phase 1·2 구현 완료, 2026-06-19)
**날짜**: 2026-06-19
**범위**: `@dongkseo/contracts`, `@dongkseo/core`, `@dongkseo/context`, 신규 `@dongkseo/tenancy`

> Nexora 자체 ADR 로그의 첫 항목. 상위 IN7 제품 결정은 `plan/adrs/`(Go/Temporal 스택)에 있고,
> 이 디렉터리는 TS 프레임워크 Nexora의 결정만 보존한다.
>
> **구현 현황**: Phase 1·2 착수 후 전체 모노레포 `pnpm -r build && pnpm -r test` green
> (629 tests, 0 fail). Phase 3은 미착수.

---

## 컨텍스트

지금 Nexora는 **논리적(namespace) 멀티테넌시**를 기본으로 강제한다. `tenantId: string`이
9개 패키지에 실처럼 꿰여 있다:

- `contracts`: `message`, `context`, `tool`, `budget`, `oracle`, `workflow-state`, `adapter`
- 격리 키: `tenantAgentScopeKey({tenantId, agentName}) → "${tenantId}:${agentName}"`
- 저장소(`store-pg`): row-level (`tenant_id TEXT NOT NULL`, PK 포함)
- 설정: `context/tenant.ts`의 `TenantConfigStore`가 per-tenant 로드

### 문제

대부분의 사용자는 **단일 테넌트**다. 그런데도 모든 메시지/컨텍스트/도구 호출이
`tenantId`를 들고 다녀야 한다. 이건 90%가 쓰지 않는 기능에 내는 **세금**이다.

코드가 이 비대칭을 증명한다 — contracts에서:

```
tenantId: string    (필수) → message, oracle, tool, workflow-state, context, budget
tenantId?: string   (선택) → transport, extension
```

핵심 경로는 강제, 일부 seam만 선택. **"테넌시가 근본인가 부가인가"를 설계가 끝까지
결정하지 않은 흔적이다.**

### 관찰 (조사로 확인)

- **core 본체는 `tenantId`를 딱 2파일에서만 읽는다** — `budget.ts`, `bootstrap.ts`.
  나머지는 전부 *타입(contracts)*이지 런타임 로직이 아니다.
- **테넌트 머신은 이미 격리돼 있다** — `context/tenant.ts`(94 LOC, `TenantConfigStore`)는
  자족적이라 사실상 추출 준비 완료.
- **주입 seam이 이미 있다** — `core/extension-loader.ts` + `core/middleware.ts`(openclaw/
  claude-code 패턴 훅). `budget-middleware.ts`는 이미 `tenantId`를 옵션으로 받는다.
- **scope 프리미티브가 이미 있다** — `createTenantAgentScope` / `tenantAgentScopeKey`.
  기본 partition은 `agentName` 하나이고, tenant는 그 앞에 `tenantId:`를 prepend하는 것일 뿐.

→ 즉 "필요할 때 import하는 테넌시"는 **새로 짓는 게 아니라, 흩어진 걸 빼서 패키지로 묶고
기존 훅에 꽂는 일.** 작업이 덧셈이 아니라 뺄셈 + 이사다.

---

## 고려한 옵션

| 옵션 | 내용 | 평가 |
|---|---|---|
| **A. 현행 유지** | tenantId 어디서나 필수 | 단일 테넌트가 영구히 세금. 기각 |
| **B. opaque `scope?`** | core는 불투명 partition 키만, tenant 해석은 패키지가 소유 | 가장 순수. 그러나 message/tool/oracle/… 전면 치환 = 대규모 breaking |
| **C. `tenantId?` 선택화 + 기본값** | 필수→선택 강등, 없으면 `DEFAULT_TENANT`. 추출은 별 패키지 | producer 소스 호환, 점진 가능. 채택 |

### 결정 — 옵션 C (단, B를 미래 경로로 명시)

**"scope는 core, tenant는 opt-in 패키지"** 를 원칙으로 한다.

- **core가 유지**: partition/scope (store·budget은 어차피 격리 키가 필요하다, 최소 `agentName`).
- **`@dongkseo/tenancy`가 소유**: tenant 개념 — resolver, 설정, 격리 해석, 파이프라인 주입.

개발자 경험:

```ts
// 기본 — tenant 단어가 어디에도 없음
const agent = createAgent({ persona, tools, store });

// 필요할 때만
import { tenancy } from '@dongkseo/tenancy';
const agent = createAgent({
  extensions: [ tenancy({ resolve: req => req.header('x-tenant-id') }) ],
  //  → persona/limits/allowlist/store/budget 가 자동으로 tenant별 분리
});
```

`tenancy()`가 없으면 런타임은 테넌트를 **모른다**. 있으면 scope가 `tenantId:agentName`으로
넓어지고 **이미 존재하는 격리 로직**이 그대로 발동한다. same primitive, 옵트인 해석.

---

## 단계 (phased)

### Phase 1 — Enabling demote ✅ (완료)

**정밀화된 원칙: optionality는 *wire 경계*에만. downstream은 bootstrap에서 한 번 resolve된 구체 `string`.**

1. `contracts`: **wire-level 필드만** optional 강등 — `MessageMetadata.tenantId?`, 인바운드
   `adapter.tenantId?`. `ToolContext` / `OracleContext` / `AgentContext` / `WorkflowCheckpoint` /
   `BudgetEvent`의 `tenantId`는 **필수 `string` 유지**(실행 시점엔 늘 resolve돼 있음).
2. `DEFAULT_TENANT = 'default'` 상수 추가. `createTenantAgentScope` / `tenantAgentScopeKey` /
   `ContextLoader.load`가 `undefined` tenantId를 `DEFAULT_TENANT`로 처리 → namespace
   하위호환(`default:agent`) 유지.
3. `core/bootstrap.ts`: **유일한 resolve 경계** — `envelope.metadata.tenantId ?? DEFAULT_TENANT`로
   한 번 resolve해 downstream 전체에 구체값을 흘림. (`budget.ts`는 비교 로직이라 무변.)
4. 다운스트림 타입 fallout은 단 2곳(`orchestrator/engine.ts`, `transport/tracing.ts` — wire
   필드를 직접 읽던 자리)만 `?? 'default'`. 전체 build+test green.

### Phase 2 — `@dongkseo/tenancy` ✅ (스캐폴드 완료)

5. 신규 `packages/tenancy` (experimental, v0.1.0). 단일 옵트인 진입점.
6. `headerTenantResolver(headerName?, fallback?)` — `HttpAdapterOptions.resolveTenant`에 꽂는
   헤더 기반 resolver. **정정**: tenant 주입의 실제 seam은 core extension이 아니라 **adapter의
   `resolveTenant` 훅**(`(req: IncomingMessage) => string | null`)이다 — 이게 bootstrap보다 앞단.
7. `TenantConfigStore` / `DEFAULT_LIMITS` / `TenantConfig`를 `@dongkseo/context`에서 re-export
   (물리 이주는 cycle 유발 — context의 ContextLoader가 소비하므로 — 보류). `tenantBudgetScope` /
   `tenantAgentBudgetScope` 헬퍼 추가. resolver/budget 유닛테스트 8개.

### Phase 3 — (선택) 물리 격리 / opaque scope

8. `StoreProvider`가 namespace를 물리 백엔드(별 DB/schema/connection)에 바인딩 가능하게 →
   "separately deployable" 테넌트. row-level → 셀-per-tenant 선택지.
9. 여력 되면 옵션 B(opaque scope)로 tenantId 어휘를 core에서 완전 제거.

---

## 근거

- **타이밍**: v0.1, 1.0 동결 전. 더 많은 패키지가 "필수 tenantId"에 매달리기 *전*이 유일한
  저비용 시점. 1.0 후엔 contracts breaking = 지옥.
- **저위험 강등**: 필수→선택은 producer 소스 호환. 읽는 쪽 2파일만 `?? DEFAULT_TENANT`.
- **추출 가능성**: 개념이 contracts(타입) + `context/tenant.ts` + 2 core 파일에 응집 → 추출 깔끔.

## 결과

- (+) 단일 테넌트 = 제로 코스트 기본값. 프레임워크 어휘에서 tenant 사라짐.
- (+) 멀티테넌트가 필요한 앱은 `@dongkseo/tenancy` 하나 import.
- (+) Fleet OS 비전과 정합 — tenant = capability 프로파일 + limits를 가진 worker 배포.
- (−) contracts breaking change(필수→선택). Phase 1에서 build/test로 흡수.
- (−) `tenantId?` 어휘가 core 타입에 잔존(옵션 C). Phase 3에서 옵션 B로 제거 가능.

## 참고

- [data-ownership.md](../data-ownership.md), [agent-fleet-os.md](../agent-fleet-os.md)
- 프리미티브: `contracts/src/context.ts` (`createTenantAgentScope`, `tenantAgentScopeKey`)
- 추출 대상: `context/src/tenant.ts` (`TenantConfigStore`)
- 주입 seam: `core/src/extension-loader.ts`, `core/src/middleware.ts`
