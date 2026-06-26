# @dongkseo/store

**Stability: advanced** · `pnpm add @dongkseo/store`

> 이 파일은 에이전트(사람·LLM)가 **소스를 열지 않고도** 이 패키지를 쓸 수 있게 하는 오리엔테이션 문서다.
> 정확한 API 타입은 "API 표면" 섹션의 방법으로 `signatures`만 읽어라 — 본문을 베끼지 말 것.

## 무엇인가 / 무엇이 아닌가

Nexora의 **영속화(store) 진입점** 패키지다. `contracts`가 정의한 store 인터페이스를 편의상 re-export하고,
설정 한 줄로 **올바른 백엔드 구현체를 묶어주는 팩토리**(`createStoreProvider`)를 제공한다.
실제 저장 로직은 이 패키지가 아니라 구현 패키지들이 가진다.

- ✅ 담는 것: store 인터페이스 re-export, 설정→구현 연결 팩토리(`createStoreProvider`), dev 백엔드 경고(`warnDevStores`)
- ❌ 안 담는 것: 실제 DB/파일 I/O, 스키마, 쿼리 — 그건 구현 패키지 몫
  - `@dongkseo/store-json` — 파일(JSON) 백엔드. `createStoreProvider({ type: 'json' })`가 동적 import
  - `@dongkseo/store-pg` — PostgreSQL 백엔드. `createStoreProvider({ type: 'pg' })`가 동적 import
  - `@dongkseo/store-memory` — 인메모리(메모리 그래프/임베딩) 백엔드. 팩토리 외부에서 직접 사용

의존 방향은 **소비자 → store → contracts**. 구현 패키지는 **런타임 동적 import**로만 연결되므로
이 패키지가 `store-json`/`store-pg`에 정적 의존하지 않는다(쓰는 백엔드만 설치하면 됨).

## 핵심 개념

| 개념 | 무엇 | 대표 export |
| --- | --- | --- |
| **StoreProvider** | 한 테넌트가 쓰는 모든 store를 묶은 번들(conversation·knowledge·schedule·ctx·audit·toolContext·suspendedTurn, 옵션 sessionTree) | `StoreProvider` |
| **StoreConfig** | 백엔드 선택 설정. `{ type: 'json'; dataDir }` 또는 `{ type: 'pg'; connectionString }` | `StoreConfig` |
| **팩토리** | 설정을 받아 구현 패키지를 동적 import하고 `StoreProvider`를 조립 | `createStoreProvider` |
| **dev 경고** | 비영속/단일프로세스 등 prod 부적합 백엔드를 부팅 시 로그로 경고 | `warnDevStores` |
| **store 인터페이스** | contracts에서 정의한 각 store 계약을 그대로 re-export | `ConversationStore`, `KnowledgeStore`, `ScheduleStore`, `ContextStore`, `AuditStore`, `ToolContextStore`, `SuspendedTurnStore` |

## 사용 레시피

설정 한 줄로 store 번들을 만든다 (`createStoreProvider`는 백엔드 패키지를 **동적 import**하므로 `await` 필요):

```ts
import { createStoreProvider, warnDevStores } from '@dongkseo/store';
import type { StoreConfig } from '@dongkseo/store';

// 개발: 파일(JSON) 백엔드 — @dongkseo/store-json 설치 필요
const config: StoreConfig = { type: 'json', dataDir: './.data' };

// 운영: PostgreSQL 백엔드 — @dongkseo/store-pg 설치 필요
// const config: StoreConfig = { type: 'pg', connectionString: process.env.DATABASE_URL! };

const stores = await createStoreProvider(config);

// 부팅 시 dev 전용 백엔드 경고 (logger는 AgentLogger)
warnDevStores(stores, logger);

// 이후 개별 store 사용
await stores.conversation.append(/* ... */);
await stores.knowledge.upsert(/* ... */);
```

정확한 store 메서드 시그니처는 아래 "API 표면"에서 `contracts/src/store.ts`를 `signatures` 모드로 읽어라.

## API 표면 (소스 안 열고 타입만)

`index.ts`는 store 인터페이스 re-export + 팩토리 두 줄로 구성되며 파일 맨 위에 **섹션 맵 주석**이 있다.
정확한 시그니처가 필요하면 구현 본문 대신 **signatures 모드**로만 읽어라:

```
ctx_read(path="packages/store/src/index.ts",            mode="map")          # 전체 export 목록
ctx_read(path="packages/store/src/factory.ts",          mode="signatures")   # createStoreProvider / StoreProvider / StoreConfig
ctx_read(path="packages/contracts/src/store.ts",        mode="signatures")   # 각 store 인터페이스 메서드
```

어떤 export가 어디서 오는지는 `src/index.ts` 상단 주석 맵을 먼저 보면 된다.

## 유지보수 (drift 방지)

- 이 README = **목적·개념·레시피** 만. 거의 안 변하므로 손으로 관리.
- **API 정본은 각 소스의 TSDoc** (`/** … */`). API가 바뀌면 코드 옆 TSDoc만 고치면 됨 — 여기 표는 복제하지 말 것.
- 새 백엔드/export가 생기면 `factory.ts`의 `StoreConfig`와 `index.ts` 상단 섹션 맵에 한 줄만 추가.

## Tests

```bash
cd packages/store && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
