# @dongkseo/core

**Stability: stable** · `pnpm add @dongkseo/core`

> 이 파일은 에이전트(사람·LLM)가 **소스를 열지 않고도** 이 패키지를 쓸 수 있게 하는 오리엔테이션 문서다.
> 정확한 API 타입은 "API 표면" 섹션의 방법으로 `signatures`만 읽어라 — 본문을 베끼지 말 것.

## 무엇인가 / 무엇이 아닌가

Nexora 에이전트 **런타임 코어**다. `contracts`의 계약(인터페이스)을 실제로 실행하는 엔진 —
LLM 호출, 도구 실행, 메모리/컴팩션, 미들웨어, 예산/타임아웃, 그리고 한 에이전트를 부팅해
transport에 붙이는 `AgentRunner` / `bootstrapAgent`가 여기 있다.

- ✅ 담는 것: LLM Provider 구현, 도구 실행기, 메모리/컨텍스트 컴팩션, 미들웨어 파이프라인,
  예산·유휴타임아웃·스키마 검증, AgentRunner/bootstrap, pi(헤드리스) 어댑터, 자기개선 루프
- ❌ 안 담는 것: 타입·인터페이스 정의(→ `contracts`), 영속 저장소 구현(→ `store-*`),
  채널·게이트웨이·HTTP 어댑터(→ `adapters`), 플릿 오케스트레이션(→ `fleet`)

의존 방향은 항상 **core → contracts** 단방향. core는 contracts에만 의존하고,
`adapters`/`fleet`/`platform`이 core에 의존한다.

## 핵심 개념

| 개념 | 무엇 | 대표 export |
|------|------|-------------|
| **LLM Provider** | LLM 호출 통합 어댑터(Anthropic·OpenAI·OpenRouter…) + 폴백 체인 | `PiAiProvider`, `FallbackLLMProvider`, `ThinkingLlmProvider` |
| **Tool Executor** | 에이전트 도구 실행·인자 강제·결과 포맷·배치 호출 | `CoreToolExecutor`, `formatToolResult`, `coerceToolArgs` |
| **Durable effects** | 도구·모델 결과 replay, 중단된 효과 감지, run lease/fencing | `DurableToolExecutor`, `DurableLLMProvider`, `MemoryEffectLedger` |
| **Memory / Compaction** | 컨텍스트 토큰 추정·축소(2단계 컴팩터)·도구출력 정리 | `CoreMemoryProvider`, `TwoStageCompactor`, `estimateTokens`, `shouldCompact` |
| **Middleware** | 실행/도구/LLM 호출 전후 훅 파이프라인 | `MiddlewarePipeline`, `loggingMiddleware`, `toolFilterMiddleware` |
| **Runner / Bootstrap** | 한 에이전트를 조립해 transport에 붙여 구동 | `AgentRunner`, `bootstrapAgent`, `RunningAgent` |
| **Guards** | 예산·비용·유휴 타임아웃·스키마 검증·카드 린트 | `createBudgetMiddleware`, `createIdleTimeout`, `createSchemaValidator`, `lintAgentCard` |
| **pi (headless)** | Multica `pi` 프로토콜 헤드리스 1회성 실행·모델 탐색 | `drivePi`, `agentEventToPiWire`, `listAvailableModels` |
| **Self-improve** | 실행 추적·학습·스킬 안전 기록 개선 루프 | `createImprovementLoop`, `LearningEngine`, `SafeSkillWriter` |
| **Runtime primitives** | 키 직렬화·키 회전·공개URL 안전 fetch·확장 로더 | `KeyedSerializer`, `RotatingKeyProvider`, `safeFetchImageBytes`, `loadExtensions` |

## 사용 레시피

한 에이전트를 부팅해서 transport에 붙인다 (`examples/e2e-demo` 기준, 실제 동작 코드):

```ts
import { bootstrapAgent, AgentRunner, CoreToolExecutor, PiAiProvider } from '@dongkseo/core';
import { createReactArchitecture } from '@dongkseo/architectures';

const llm = new PiAiProvider({
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const agent = await bootstrapAgent({
  card,                          // @dongkseo/contracts 의 AgentCard
  contextLoader,
  transport,
  createRuntime: () => new AgentRunner({
    architecture: createReactArchitecture({ systemPrompt: 'Test agent.' }),
    llm,
    tools: new CoreToolExecutor({
      tools,                     // 도구 핸들러 배열
      context: {
        tenantId: 'test',
        workdir: process.cwd(),
        secrets: { get: async () => undefined },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      },
    }),
  }),
  toAgentInput: (env) => ({ prompt: (env.payload as { prompt?: string }).prompt ?? '' }),
});
// … 종료 시: await agent.shutdown();
```

폴백·예산 가드를 얹으려면 `FallbackLLMProvider`로 provider를 묶고 `createBudgetMiddleware`를 파이프라인에 추가한다.
더 큰 예제: [`examples/auto-work-flow`](../../examples/auto-work-flow) (PM→Coder→Reviewer 멀티에이전트, suspend/재개 포함).

도구와 모델 효과를 durable boundary로 실행하려면 runtime에 ledger와 안정적인 실행 id를 준다.
완료된 `runId + callId` 및 동일한 model-visible request는 기록된 결과를 replay한다. `running`
intent만 남은 호출은 외부 효과를 중복 실행하지 않고 `IndeterminateEffectError`를 발생시킨다.

```ts
import { AgentRunner, MemoryEffectLedger } from '@dongkseo/core';

const runtime = new AgentRunner({
  architecture,
  llm,
  tools,
  durability: {
    ledger: new MemoryEffectLedger(), // 개발/테스트 전용; 운영에서는 durable EffectLedger 구현 주입
    runId: envelope.id,
    modelIdentity: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
  },
});
```

한 batch는 모든 호출이 `isConcurrencySafe`를 명시한 경우에만 병렬 실행된다. call id가 없거나
한 batch 안에서 중복되면 어떤 효과도 시작하기 전에 거부한다.

모델 stream은 첫 chunk 전에 실패하면 intent를 제거해 기존 fallback/retry 정책이 작동한다.
한 chunk라도 호출자에게 노출된 뒤 중단되면 intent를 `running`으로 보존해 중복 출력과 중복
과금을 막는다. `modelIdentity`에는 API key 같은 secret이 아니라 provider/model/config의 안정적인
식별자만 넣는다.

## API 표면 (소스 안 열고 타입만)

`index.ts`는 도메인별로 그룹핑돼 있고 파일 맨 위에 **섹션 맵 주석**이 있다. 정확한 시그니처가 필요하면
구현 본문 대신 **signatures 모드**로만 읽어라:

```
ctx_read(path="packages/core/src/index.ts",         mode="map")          # 전체 export 목록
ctx_read(path="packages/core/src/runner.ts",        mode="signatures")   # AgentRunner
ctx_read(path="packages/core/src/bootstrap.ts",     mode="signatures")   # bootstrapAgent
ctx_read(path="packages/core/src/llm/index.ts",     mode="signatures")   # PiAiProvider, FallbackLLMProvider
ctx_read(path="packages/core/src/tool-executor.ts", mode="signatures")   # CoreToolExecutor
ctx_read(path="packages/core/src/durable-tool-executor.ts", mode="signatures") # durable effects
ctx_read(path="packages/core/src/durable-llm-provider.ts", mode="signatures")  # durable model calls
ctx_read(path="packages/core/src/pi-headless.ts",   mode="signatures")   # drivePi
```

어떤 파일에 뭐가 있는지는 `src/index.ts` 상단 주석 맵을 먼저 보면 된다.

## 유지보수 (drift 방지)

- 이 README = **목적·개념·레시피** 만. 거의 안 변하므로 손으로 관리.
- **API 정본은 각 소스의 TSDoc** (`/** … */`). API가 바뀌면 코드 옆 TSDoc만 고치면 됨 — 여기 표는 복제하지 말 것.
- 새 모듈을 export하면 `index.ts` 상단 섹션 맵에 한 줄만 추가.

## Tests

```bash
cd packages/core && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
