# @dongkseo/registry

**Stability: stable** · `pnpm add @dongkseo/registry`

> 이 파일은 에이전트(사람·LLM)가 소스를 열지 않고도 이 패키지를 쓸 수 있게 하는 오리엔테이션 문서다.
> 정확한 API 타입은 "API 표면"의 방법으로 `signatures`만 읽어라 — 본문을 베끼지 말 것.

## 무엇인가 / 무엇이 아닌가

에이전트 카드(AgentCard)의 **레지스트리**다. 이름·capability·구독 토픽으로 에이전트를 등록·조회한다.

- ✅ 담는 것: 인메모리 AgentRegistry 구현(`InMemoryAgentRegistry`)과 등록/조회 API
- ❌ 안 담는 것: AgentCard 타입 정의(→ `@dongkseo/contracts`), 라우팅/게이트웨이(→ `@dongkseo/gateway`), capability 매칭 기반 워커 dispatch(→ `@dongkseo/fleet`)

의존 방향: **registry → contracts** 단방향. `@dongkseo/gateway`가 registry에 의존한다.

## 핵심 개념

| 개념 | 무엇 | 대표 export |
| --- | --- | --- |
| **AgentRegistry** | 이름/capability/구독 토픽으로 AgentCard를 등록·조회하는 인메모리 저장소 | `InMemoryAgentRegistry` |

메서드: `register(card)`, `unregister(name)`, `get(name)`, `list()`, `findByCapability(capability)`, `findBySubscription(topic)`.

## 사용 레시피

```ts
import { InMemoryAgentRegistry } from '@dongkseo/registry';
import type { AgentCard } from '@dongkseo/contracts';

const registry = new InMemoryAgentRegistry();
await registry.register(card);                      // AgentCard 등록

const coder = await registry.get('coder');          // 이름으로 조회 (없으면 null)
const writers = await registry.findByCapability('write');   // capability로 필터
const subs = await registry.findBySubscription('agent.task'); // 토픽 구독자
const all = await registry.list();
```

## API 표면 (소스 안 열고 타입만)

```
ctx_read(path="platform/registry/src/index.ts", mode="signatures")   # InMemoryAgentRegistry
```
`AgentCard` 타입은 `ctx_read(path="packages/contracts/src/index.ts", mode="map")`.

## 유지보수 (drift 방지)

- 이 README = 목적·개념·레시피만. API 정본은 소스 TSDoc.
- 새 export가 생기면 `src/index.ts` 상단/이 표에 한 줄만 추가.

## Tests

```bash
cd platform/registry && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
