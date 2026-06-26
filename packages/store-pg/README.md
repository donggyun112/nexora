# @dongkseo/store-pg

**Stability: experimental** · `pnpm add @dongkseo/store-pg`

> 이 파일은 에이전트(사람·LLM)가 **소스를 열지 않고도** 이 패키지를 쓸 수 있게 하는 오리엔테이션 문서다.
> 정확한 API 타입은 "API 표면" 섹션의 방법으로 `signatures`만 읽어라 — 본문을 베끼지 말 것.

## 무엇인가 / 무엇이 아닌가

`@dongkseo/contracts`가 정의한 **Store 백엔드 계약의 PostgreSQL 구현체**다. `ConversationStore`,
`KnowledgeStore`, `AuditStore`, `ScheduleStore`, `ContextStore`, `ToolContextStore`,
`SuspendedTurnStore`, 세션 트리(분기 대화)를 Postgres 위에 영속화하고, Redis 기반 분산
레이트리미터·버짓 트래커도 함께 제공한다. `store-json`(JSON 파일) 대비 **재시작에도 살아남고,
멀티프로세스 동시 접근에 안전하며, Redis로 공유 상태를 분산**한다.

- ✅ 담는 것: 계약 인터페이스의 PG 구현 클래스(`ConversationStorePg` …), 한 번에 전부 생성하는 `createPgStoreProvider`, 커넥션 헬퍼 `createPgClient`, Redis 분산 유틸
- ❌ 안 담는 것: Store **인터페이스 정의**(그건 `contracts` 몫), 오케스트레이션/LLM 호출, 개발용 인메모리/파일 구현(`store-memory`/`store-json`)
- 의존 방향은 **store-pg → contracts** 단방향. 계약을 구현할 뿐 계약을 정의하지 않는다.

런타임 의존: `postgres`(postgres.js 드라이버)에 의존하며 PostgreSQL 서버 연결이 필요하다.
Redis 유틸을 쓸 때는 `RedisLike` 호환 클라이언트를 직접 주입한다(특정 redis 패키지를 강제하지 않음).

## 핵심 개념

| 개념 | 무엇 | 대표 export |
| **PG 커넥션** | postgres.js 풀 생성·스키마 초기화·종료 핸들 | `createPgClient`, `PgOptions`, `Sql` |
| **Store 구현** | 계약 인터페이스별 PG 구현 클래스 | `ConversationStorePg`, `KnowledgeStorePg`, `AuditStorePg`, `ScheduleStorePg`, `ContextStorePg`, `ToolContextStorePg`, `TranscriptStorePg`, `SuspendedTurnStorePg` |
| **세션 트리** | 분기 가능한 대화 트리 PG 구현 | `TreeConversationStorePg` |
| **Provider 번들** | 하나의 커넥션으로 6개 코어 스토어 전부 생성 | `createPgStoreProvider`, `PgStoreProvider` |
| **분산 레이트리미터** | Redis 기반 분산 처리율 제한 | `createRedisRateLimiter`, `DistributedRateLimiter`, `RedisRateLimiterOptions` |
| **분산 버짓** | Redis 기반 분산 예산 추적 | `createRedisBudgetTracker`, `DistributedBudgetTracker`, `RedisBudgetOptions` |

## 사용 레시피

커넥션을 열고 전체 스토어 번들을 만든다 (`@dongkseo/store` 팩토리의 `pg` 분기와 동일한 경로):

```ts
import { createPgClient, createPgStoreProvider } from '@dongkseo/store-pg';

// 1) 커넥션 풀 + 스키마 초기화 (autoMigrate 기본 true)
const { sql, close } = await createPgClient({
  connectionString: 'postgres://user:pass@host:5432/db',
  maxConnections: 10, // 선택 (기본 10)
});

// 2) 6개 코어 스토어를 한 번에 생성
const store = createPgStoreProvider(sql);
await store.conversation.append(/* ... 계약 시그니처대로 ... */);

// 3) 종료
await close();
```

개별 스토어만 쓰려면 클래스를 직접 인스턴스화한다 (`sql`은 `createPgClient`가 돌려준 핸들):

```ts
import { createPgClient, ConversationStorePg } from '@dongkseo/store-pg';

const { sql } = await createPgClient({ connectionString: process.env.DATABASE_URL! });
const conversations = new ConversationStorePg(sql);
```

`@dongkseo/store`의 `createStoreProvider({ kind: 'pg', connectionString })`를 쓰면 이 패키지를
동적 import해서 위 과정을 대신 해 준다 — 직접 구성할 필요가 없으면 그 팩토리를 통하는 것이 표준이다.

## API 표면 (소스 안 열고 타입만)

`index.ts`는 도메인별로 그룹핑돼 있고 파일 맨 위에 **섹션 맵 주석**이 있다. 정확한 시그니처가 필요하면
구현 본문 대신 **signatures 모드**로만 읽어라:

```bash
ctx_read(path="packages/store-pg/src/index.ts",      mode="map")          # 전체 export 목록
ctx_read(path="packages/store-pg/src/pg-client.ts",  mode="signatures")   # createPgClient / PgOptions / Sql
ctx_read(path="packages/store-pg/src/conversation.ts", mode="signatures") # 한 스토어 구현 예시
```

각 스토어가 만족하는 인터페이스(메서드 시그니처)의 정본은 `@dongkseo/contracts`의 store 타입이다:

```bash
ctx_read(path="packages/contracts/src/store.ts", mode="signatures")
```

어떤 파일에 뭐가 있는지는 `src/index.ts` 상단 주석 맵을 먼저 보면 된다.

## 유지보수 (drift 방지)

- 이 README = **목적·개념·레시피** 만. 거의 안 변하므로 손으로 관리.
- **API 정본은 각 소스의 TSDoc** (`/** … */`)과 `@dongkseo/contracts`의 store 인터페이스. API가 바뀌면 코드 옆 TSDoc만 고치면 됨 — 여기 표는 복제하지 말 것.
- 새 모듈을 export하면 `index.ts` 상단 섹션 맵에 한 줄만 추가.

## Tests

통합 테스트는 실제 PostgreSQL이 필요하다:

```bash
cd packages/store-pg && DATABASE_URL=postgres://... pnpm test:integration
```

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
