# @dongkseo/fleet

**Stability: beta** · `pnpm add @dongkseo/fleet`

> 이 파일은 에이전트(사람·LLM)가 **소스를 열지 않고도** 이 패키지를 쓸 수 있게 하는 오리엔테이션 문서다.
> 정확한 API 타입은 "API 표면" 섹션의 방법으로 `signatures`만 읽어라 — 본문을 베끼지 말 것.

## 무엇인가 / 무엇이 아닌가

외부 에이전트를 **워커(worker)** 로 등록·선택·호출하는 **코디네이션 레이어**다. Nexora를 한 대의
프로세스가 아니라 워커 클러스터로 굴릴 때 첫 번째 구체 구현체 역할을 한다: 워커가 capability로
자기 능력을 등록하고, fleet이 capability에 맞는 워커를 골라 프로토콜 어댑터(HTTP 등)로 호출한다.
oracle이 연결돼 있으면 호출/제출 전후로 정책 판정을 받는다.

- ✅ 담는 것: 워커 레지스트리(in-memory 구현), capability 기반 선택, 단일 dispatch·다중 broadcast 코디네이션, oracle 정책 게이트, HTTP 워커 호출기
- ❌ 안 담는 것: 타입/계약 정의(`contracts` 몫), oracle 정책 *내용*(주입받음), 영속 저장소, LLM 호출, 워커 자신의 비즈니스 로직

의존 방향: **fleet → contracts** (단방향). `WorkerRegistry`·`WorkerInvoker`·`NexoraOracle` 등 계약은
모두 `@dongkseo/contracts`에서 가져와 구현/소비만 한다.

## 핵심 개념

| 개념 | 무엇 | 대표 export |
| --- | --- | --- |
| **Worker registry** | 워커 등록·하트비트·capability 조회를 담는 메모리 저장소 (`WorkerRegistry` 구현) | `InMemoryWorkerRegistry` |
| **Worker selection** | 건강(health) 기준으로 후보 중 한 워커 선택 | `selectWorker`, `WorkerSelectionOptions` |
| **Dispatch** | capability 한 건을 선택된 워커 한 명에게 위임 | `FleetCoordinator.dispatch`, `FleetDispatchInput/Result` |
| **Broadcast** | capability를 여러 워커에 동시 전파(first/quorum/all 모드) | `FleetCoordinator.broadcast`, `FleetBroadcastInput/Result` |
| **Oracle wiring** | dispatch/broadcast 호출 전후 정책 판정 게이트 | `FleetCoordinatorOptions.oracle`, `OracleRejectedSyscallError` |
| **HTTP invoker** | 워커 endpoint로 실제 HTTP 호출하는 `WorkerInvoker` 구현 | `HttpWorkerInvoker`, `HttpWorkerInvokerOptions` |
| **선택 실패** | capability를 만족하는 건강한 워커가 없을 때 | `NoWorkerForCapabilityError` |

## 사용 레시피

워커를 등록하고 capability로 조회한다 (`src/__tests__/fleet.test.ts` 기준, 실제 동작 코드):

```ts
import { InMemoryWorkerRegistry } from '@dongkseo/fleet';

const registry = new InMemoryWorkerRegistry();
await registry.register({
  id: 'writer-1',
  adapter: 'http',
  provides: ['marketing.long-form-content@v1'],
  endpoint: { type: 'http', url: 'https://workers.test/writer-1' },
  version: '0.1.0',
});

const workers = await registry.findByCapability('marketing.long-form-content@v1');
```

capability 한 건을 워커에게 위임한다 (`FleetCoordinator`):

```ts
import { FleetCoordinator, InMemoryWorkerRegistry } from '@dongkseo/fleet';
import type { OracleContext } from '@dongkseo/contracts';

const coordinator = new FleetCoordinator({
  registry,                 // 위에서 만든 InMemoryWorkerRegistry
  invoker: { invoke },      // WorkerInvoker — 직접 구현하거나 HttpWorkerInvoker 사용
  // oracle, policy, selection 은 선택
});

const context: OracleContext = {
  tenantId: 'tenant-a',
  conversationId: 'conversation-a',
  traceId: 'trace-a',
  spanId: 'span-a',
};

const result = await coordinator.dispatch({
  id: 'dispatch-1',
  capability: 'marketing.long-form-content@v1',
  input: { title: 'Nexora' },
  context,
});
// result.worker / result.result / result.decisions
```

여러 워커에 동시에 전파하려면 `coordinator.broadcast({ ..., mode, quorum })`를 쓴다(모드: first/quorum/all).
실제 HTTP 워커를 부르려면 `invoker`에 `new HttpWorkerInvoker()`를 넘긴다.

## API 표면 (소스 안 열고 타입만)

`index.ts`는 클래스 구현 + 도메인별 그룹으로 돼 있고 파일 맨 위에 **섹션 맵 주석**이 있다.
정확한 시그니처가 필요하면 구현 본문 대신 **signatures / map 모드**로만 읽어라:

```
ctx_read(path="packages/fleet/src/index.ts", mode="map")          # 전체 export·심볼 위치
ctx_read(path="packages/fleet/src/index.ts", mode="signatures")   # 클래스/함수 시그니처만
```

어떤 심볼이 몇 번째 줄에 있는지는 `src/index.ts` 상단 주석 맵을 먼저 보면 된다.

## 유지보수 (drift 방지)

- 이 README = **목적·개념·레시피** 만. 거의 안 변하므로 손으로 관리.
- **API 정본은 소스의 시그니처 + TSDoc** (`/** … */`). API가 바뀌면 코드만 고치면 됨 — 여기 표는 복제하지 말 것.
- 새 심볼을 export하면 `index.ts` 상단 섹션 맵에 한 줄만 추가.

## Tests

```bash
cd packages/fleet && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
