# @dongkseo/architectures

**Stability: stable**

```bash
pnpm add @dongkseo/architectures
```

## 무엇인가 / 무엇이 아닌가

에이전트의 **사고·실행 루프(agent architecture)** 를 구현한다. agent card 의 `architecture` 필드가
선언한 패턴(`'react'`, `'plan-execute'`)을, runner 가 돌리는 실제 `AgentArchitecture` 인스턴스로
만들어 준다. LLM 한 턴이 도구를 어떻게 부르고 언제 멈추는지가 여기 있다.

의존 방향: `@dongkseo/architectures` → `@dongkseo/contracts` (타입만). 이 패키지는 계약을 **구현**하는
쪽이고, contracts 는 구현을 모른다.

- ✅ 담는 것: ReAct 루프, plan→execute 2-phase 루프(도구 게이팅으로 plan mode 강제), 카드 선언
  문자열을 인스턴스로 변환하는 dispatch table, 한 턴 내부 history 압축(컨텍스트 윈도우 프루닝).
- ❌ 안 담는 것: LLM 클라이언트/어댑터(`@dongkseo/adapters`), 도구 구현, 워커·런타임 오케스트레이션,
  영속화. `RuntimeServices`(LLM·도구·signal)는 caller 가 주입한다.

## 핵심 개념

| 개념 | 무엇 | 대표 export |
|------|------|-------------|
| **ReAct** | Reasoning + Acting 루프. 가장 일반적인 도구 호출 에이전트 | `createReactArchitecture`, `ReactOptions` |
| **Plan-Execute** | PLAN phase(마무리 도구를 숨겨 계획을 먼저 강제) → EXECUTE phase. plan mode 공식화 | `createPlanExecuteArchitecture`, `PlanExecuteOptions` |
| **Architecture registry** | 카드의 `architecture` 문자열 → factory 호출 단일 dispatch | `resolveArchitecture`, `isSupportedArchitecture`, `SUPPORTED_ARCHITECTURES` |
| **Build context** | registry 가 인스턴스를 만들 때 받는 입력(system prompt·model·도구 게이팅) | `ArchitectureBuildContext`, `SupportedArchitecture` |
| **Loop compaction** | 한 턴 내부 history 의 오래된 큰 tool_result 를 결정적으로 프루닝 | `LoopCompactionOptions` |

## 사용 레시피

ReAct 아키텍처를 만들어 runner 에 넘긴다 (`examples/helpdesk` 기준, 실제 동작 코드):

```ts
import { createReactArchitecture } from '@dongkseo/architectures';

const runner = new AgentRunner({
  architecture: createReactArchitecture({
    systemPrompt: context.systemPrompt,
    model: context.limits.model,
    maxTokens: context.limits.maxTokens,
    // maxIterations?: 도구 호출 라운드 상한 (기본 25)
  }),
  llm,
  tools,
});
```

가벼운 데모는 옵션만 추려서도 충분하다 (`examples/e2e-demo`):

```ts
import { createReactArchitecture } from '@dongkseo/architectures';

createReactArchitecture({ systemPrompt: PROMPTS[card.name], maxIterations: 8 });
```

카드가 선언한 문자열을 인스턴스로 변환할 때는 registry 를 쓴다 (runner 내부 패턴):

```ts
import { resolveArchitecture, isSupportedArchitecture } from '@dongkseo/architectures';

if (!isSupportedArchitecture(card.architecture)) throw new Error('미지원 아키텍처');
const architecture = resolveArchitecture(card.architecture, {
  systemPrompt,
  model: limits.model,
  maxTokens: limits.maxTokens,
  // plan-execute 선택 시 exitPlanTool 필수
});
```

plan-execute 는 PLAN→EXECUTE 전이 도구를 반드시 지정한다:

```ts
import { createPlanExecuteArchitecture } from '@dongkseo/architectures';

createPlanExecuteArchitecture({
  exitPlanTool: 'submit_research_plan',            // PLAN phase 를 닫는 도구 (필수, 실제 등록된 도구명)
  executePhaseTools: ['submit_keywords'],          // EXECUTE phase 에서만 노출 (PLAN 에선 숨김)
});
```

더 큰 예제: [`examples/auto-work-flow`](../../examples/auto-work-flow), [`examples/helpdesk`](../../examples/helpdesk).

## API 표면 (소스 안 열고 타입만)

`index.ts`는 파일별로 그룹핑돼 있고 맨 위에 **섹션 맵 주석**이 있다. 정확한 시그니처가 필요하면
구현 본문 대신 **signatures 모드**로만 읽어라:

```
ctx_read(path="packages/architectures/src/react.ts",         mode="signatures")
ctx_read(path="packages/architectures/src/plan-execute.ts",  mode="signatures")
ctx_read(path="packages/architectures/src/resolve.ts",       mode="signatures")
ctx_read(path="packages/architectures/src/index.ts",         mode="map")   # 전체 export 목록
```

어떤 파일에 뭐가 있는지는 `src/index.ts` 상단 주석 맵을 먼저 보면 된다.

## 유지보수 (drift 방지)

- 이 README = **목적·개념·레시피** 만. 거의 안 변하므로 손으로 관리.
- **API 정본은 각 소스의 TSDoc** (`/** … */`). API가 바뀌면 코드 옆 TSDoc만 고치면 됨 — 여기 표는 복제하지 말 것.
- 새 모듈을 export하면 `index.ts` 상단 섹션 맵에 한 줄만 추가.

## Tests

```bash
cd packages/architectures && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
