# @dongkseo/transport

**Stability: stable** · `pnpm add @dongkseo/transport`

> 이 파일은 에이전트(사람·LLM)가 **소스를 열지 않고도** 이 패키지를 쓸 수 있게 하는 오리엔테이션 문서다.
> 정확한 API 타입은 "API 표면" 섹션의 방법으로 `signatures`만 읽어라 — 본문을 베끼지 말 것.

## 무엇인가 / 무엇이 아닌가

에이전트 간 **이벤트 통신 계층(EventTransport)의 구현체 모음**이다. `@dongkseo/contracts`의
`./transport` 계약(`EventTransport`, `DurableTransport`, `assertDurable`)을 만족하는 구체 트랜스포트를 제공한다.
모두 **topic 기반 pub/sub + request/reply**라는 같은 인터페이스를 따르므로, 같은 에이전트 코드를 인메모리에서
Redis로 그대로 옮길 수 있다.

- ✅ 담는 것: `EventTransport`/`DurableTransport` 구현(로컬·Redis·DLQ·트레이싱 래퍼), `createEnvelope` 헬퍼, trace 전파(`withTrace`)
- ❌ 안 담는 것: 트랜스포트 **인터페이스/타입 정의**(그건 `contracts/transport`), 워크플로 엔진(`orchestrator`), LLM 호출(`core`)

의존 방향은 항상 **transport → contracts** 단방향. `core`·`orchestrator`·`platform`이 transport에 의존한다.

## 핵심 개념

| 개념 | 무엇 | 대표 export |
| --- | --- | --- |
| **로컬 트랜스포트** | 인메모리 EventTransport (at-most-once, dev/test) | `LocalTransport`, `createEnvelope` |
| **Redis PubSub** | Redis PUBSUB 기반 분산 EventTransport (at-most-once) | `RedisTransport` |
| **Redis Streams** | Redis Streams 기반 **DurableTransport** (at-least-once, consumer group, prod 워크플로 경로) | `RedisStreamsTransport` |
| **인메모리 Durable** | 컨슈머 그룹/ack/nack를 흉내내는 인메모리 DurableTransport (durable 경로 테스트용) | `InMemoryDurableTransport` |
| **DLQ 래퍼** | 중복 제거 + 실패 메시지를 dead-letter topic으로 보내는 데코레이터 | `DLQTransport` |
| **Tracing 래퍼** | AsyncLocalStorage로 trace context를 publish/subscribe 경계 너머로 전파 | `TracingTransport`, `withTrace`, `currentTrace` |

`describe()`는 모든 트랜스포트가 구현하며, 런타임에서 delivery guarantee를 검사할 때 쓴다(`assertDurable`).

## 사용 레시피

기본: 로컬 트랜스포트를 만들고 발행/구독한다 (`platform/cli` dev 부팅과 동일한 패턴).

```ts
import { LocalTransport, createEnvelope } from '@dongkseo/transport';

const transport = new LocalTransport();

// 구독: 토픽 패턴(`*`=한 세그먼트, `#`=나머지 전부)
const sub = transport.subscribe('agent.coder.*', async (env) => {
  console.log(env.topic, env.payload);
});

// 발행: createEnvelope로 표준 봉투를 만든 뒤 publish
await transport.publish(
  createEnvelope({ topic: 'agent.coder.task', payload: { goal: '버그 수정' } }),
);

// request/reply: 응답 봉투(metadata.replyTo === requestId)를 기다림
const reply = await transport.request('agent.coder.task', { goal: '리뷰' });

sub.unsubscribe();
await transport.close();
```

프로덕션: 워크플로 엔진은 **durable 트랜스포트**를 요구한다 (`orchestrator` 엔진 패턴).

```ts
import { RedisStreamsTransport } from '@dongkseo/transport';
import { assertDurable } from '@dongkseo/contracts';

const transport = new RedisStreamsTransport({ redis /* ioredis 호환 client */ });
assertDurable(transport); // at-least-once가 아니면 여기서 throw — prod 안전장치

// 컨슈머 그룹으로 구독하면 ack/nack로 재처리/유실 방지가 가능
transport.subscribeGroup('agent.#', 'workers', async (env, ctrl) => {
  await handle(env);
  await ctrl.ack();
});
```

기존 트랜스포트를 래핑해 DLQ·트레이싱을 입힐 수도 있다 (데코레이터).

```ts
import { LocalTransport, DLQTransport, TracingTransport } from '@dongkseo/transport';

const base = new LocalTransport();
const traced = new TracingTransport(base);                          // trace 전파
const transport = new DLQTransport({ inner: traced, dlqTopic: 'dlq' }); // 실패 → dead-letter
```

## API 표면 (소스 안 열고 타입만)

`index.ts` 맨 위에 **섹션 맵 주석**이 있고, 각 트랜스포트는 파일별로 분리돼 있다. 정확한 시그니처가
필요하면 구현 본문 대신 **signatures 모드**로만 읽어라:

```
ctx_read(path="packages/transport/src/index.ts",         mode="map")        # 전체 export 목록
ctx_read(path="packages/transport/src/local.ts",         mode="signatures") # LocalTransport, createEnvelope
ctx_read(path="packages/transport/src/redis-streams.ts", mode="signatures") # RedisStreamsTransport (durable)
ctx_read(path="packages/transport/src/dlq.ts",           mode="signatures") # DLQTransport
ctx_read(path="packages/transport/src/tracing.ts",       mode="signatures") # TracingTransport, withTrace
```

트랜스포트 **인터페이스/타입**(`EventTransport`, `DurableTransport`, `DeliveryControl`, `assertDurable` 등)은
이 패키지가 아니라 `@dongkseo/contracts`의 `./transport`에 있다:

```
ctx_read(path="packages/contracts/src/transport.ts", mode="signatures")
```

## 유지보수 (drift 방지)

- 이 README = **목적·개념·레시피** 만. 거의 안 변하므로 손으로 관리.
- **API 정본은 각 소스의 TSDoc** (`/** … */`). API가 바뀌면 코드 옆 TSDoc만 고치면 됨 — 여기 표는 복제하지 말 것.
- 새 트랜스포트를 export하면 `index.ts` 상단 섹션 맵에 한 줄만 추가.

## Tests

```bash
cd packages/transport && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework.
