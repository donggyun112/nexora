# @dongkseo/orchestrator

**Stability: stable** · `pnpm add @dongkseo/orchestrator`

워크플로우 실행 엔진과 스케줄러. `WorkflowContract`를 transport request/reply 위로 단계별 실행하고, 주기/일회성 작업을 외부 cron 라이브러리 없이 돌린다.

## 무엇인가 / 무엇이 아닌가

`@dongkseo/contracts`의 `WorkflowContract`·`EventTransport`를 받아 **여러 에이전트 호출을 순서대로 엮는 실행 계층**이다. 단계 결과를 다음 단계 입력으로 흘려보내고, state store가 있으면 단계마다 체크포인트를 남겨 크래시 후 재개(resume)를 지원한다.

- ✅ `WorkflowContract` 단계별 실행 (transport로 request/reply, 단계 간 입력 매핑)
- ✅ state store 기반 체크포인트 + `resume(workflowId)` 재개
- ✅ in-memory state / suspended-turn 스토어 기본 구현 제공
- ✅ `CronScheduler`로 interval / one-shot 작업 스케줄링
- ❌ 에이전트 런타임·LLM 호출·도구 실행 자체 (→ `@dongkseo/core`)
- ❌ transport 구현체 (durable 큐 등은 어댑터가 주입 — 여기는 인터페이스만 소비)
- ❌ cron 표현식 파싱 (`intervalMs` 또는 주입한 `nextRunAt`만 사용)

의존 방향: orchestrator → **contracts** (타입/transport 인터페이스). core·adapters에는 의존하지 않는다.

## 핵심 개념

| 개념 | 무엇 | 대표 export |
| --- | --- | --- |
| **Workflow engine** | `WorkflowContract`를 단계별로 실행·재개 | `WorkflowEngine` |
| **State store** | 단계 전이마다 체크포인트 저장 (재개 키 = `workflowId`) | `InMemoryWorkflowStateStore` |
| **Suspended turn store** | 일시 중단된 턴(승인 대기 등) 상태 보관 | `InMemorySuspendedTurnStore` |
| **Cron scheduler** | interval / one-shot 작업 스케줄러 | `CronScheduler`, `intervalJob`, `oneShotJob` |

## 사용 레시피

### 워크플로우 실행

`WorkflowContract`와 `EventTransport`(어댑터에서 주입)를 넘겨 실행한다. state store를 주면 단계마다 체크포인트가 남는다.

```ts
import {
  WorkflowEngine,
  InMemoryWorkflowStateStore,
} from '@dongkseo/orchestrator';

const engine = new WorkflowEngine({
  transport,                                // EventTransport (@dongkseo/contracts)
  stateStore: new InMemoryWorkflowStateStore(),
  defaultStepTimeoutMs: 60_000,
});

const result = await engine.run(workflow, {
  workflowId: 'run-001',                    // state store 있으면 필수 (체크포인트 키)
  input: { goal: 'ship feature X' },        // template/fromStep 입력에서 key='input'로 참조
  tenantId: 'default',
});

if (result.status === 'completed') {
  for (const step of result.steps) {
    console.log(step.stepId, step.topic, step.payload);
  }
}
```

크래시 후 같은 `workflowId`로 마지막 체크포인트부터 재개:

```ts
const resumed = await engine.resume(workflow, 'run-001');
```

durable transport를 강제하는 프로덕션 러너:

```ts
const engine = WorkflowEngine.production({ transport: durableTransport });
```

### 일시 중단된 턴 보관

승인 대기 등으로 중단된 턴 상태를 저장/조회한다 (`examples/auto-work-flow`에서 사용).

```ts
import { InMemorySuspendedTurnStore } from '@dongkseo/orchestrator';

const suspendedTurnStore = new InMemorySuspendedTurnStore();
// store.save(state) / store.load(pendingId) / store.listAwaiting()
```

### 스케줄러

```ts
import { CronScheduler, intervalJob, oneShotJob } from '@dongkseo/orchestrator';

const scheduler = new CronScheduler();
scheduler.schedule(intervalJob('heartbeat', 30_000, async () => { /* ... */ }));
scheduler.schedule(oneShotJob('warmup', 1_000, async () => { /* ... */ }));
await scheduler.trigger('heartbeat');       // 수동 트리거
scheduler.stop();
```

## API 표면 (소스 안 열고 타입만)

`index.ts` 상단에 **섹션 맵 주석**이 있다. 정확한 시그니처는 구현 본문 대신 **signatures 모드**로만 읽어라:

```
ctx_read(path="packages/orchestrator/src/engine.ts",               mode="signatures")
ctx_read(path="packages/orchestrator/src/cron.ts",                 mode="signatures")
ctx_read(path="packages/orchestrator/src/workflow-state-store.ts", mode="signatures")
ctx_read(path="packages/orchestrator/src/index.ts",                mode="map")   # 전체 export 목록
```

## 유지보수 (drift 방지)

- 이 README = **목적·개념·레시피** 만. 거의 안 변하므로 손으로 관리.
- **API 정본은 각 소스의 TSDoc** (`/** … */`). API가 바뀌면 코드 옆 TSDoc만 고치면 됨 — 여기 표는 복제하지 말 것.
- 새 모듈을 export하면 `index.ts` 상단 섹션 맵에 한 줄만 추가.

## Tests

```bash
cd packages/orchestrator && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
