# @dongkseo/store-json

**Stability: advanced** · `pnpm add @dongkseo/store-json`

> 이 파일은 에이전트(사람·LLM)가 **소스를 열지 않고도** 이 패키지를 쓸 수 있게 하는 오리엔테이션 문서다.
> 정확한 API 타입은 "API 표면" 섹션의 방법으로 `signatures`만 읽어라 — 본문을 베끼지 말 것.

## 무엇인가 / 무엇이 아닌가

`@dongkseo/contracts`가 정의한 **store 백엔드 계약**(`ConversationStore`, `KnowledgeStore`,
`TranscriptStore`, `SuspendedTurnStore` …)을 **JSON 파일**로 구현한 패키지다. `dataDir` 하위에
대화·지식·스케줄·감사 로그 등을 파일로 떨어뜨린다.

- ✅ 담는 것: 각 store 계약의 파일 기반 구현 클래스(`*StoreJson`), 한 번에 묶어 만드는 `createJsonStoreProvider`
- ❌ 안 담는 것: store 계약 정의(그건 `contracts`), 프로덕션 내구성/동시성 보장, DB 연결 — 그건 `store-pg` 몫

의존 방향은 **store-json → contracts** 단방향. 이 패키지는 보통 직접 import 하지 않고
`@dongkseo/store` 팩토리가 `type: 'json'`일 때 동적으로 로드한다.

> **개발용 백엔드.** 모든 store의 `describeBackend()`는 `type: 'dev'`, `multiProcess: false`를
> 보고한다. 프로세스 간 동시 접근에 안전하지 않으므로 프로덕션 멀티테넌트에는 `@dongkseo/store-pg`를 써라.

## 핵심 개념

| 개념 | 무엇 | 대표 export |
| --- | --- | --- |
| **Provider** | 모든 store를 한 객체로 묶어 생성 | `createJsonStoreProvider`, `JsonStoreProvider` |
| **Conversation** | 선형 대화 기록(append/getHistory/compaction) | `ConversationStoreJson` |
| **Session tree** | 분기 가능한 세션 트리(branch/buildContext/leaf) | `TreeConversationStoreJson` |
| **Transcript** | `ContentBlock` 단위 상세 기록 | `TranscriptStoreJson` |
| **Knowledge / Schedule** | 지식 토픽·예약 작업 영속화 | `KnowledgeStoreJson`, `ScheduleStoreJson` |
| **Context / Audit / Tool** | 컨텍스트·감사 로그·도구 컨텍스트 | `ContextStoreJson`, `AuditStoreJson`, `ToolContextStoreJson` |
| **Suspended turn** | HITL(휴먼인더루프) 일시중단 턴 저장 | `SuspendedTurnStoreJson` |

## 사용 레시피

보통은 `@dongkseo/store` 팩토리로 받는다 (`packages/store/src/factory.ts` 기준, 실제 동작 코드):

```ts
import { createStoreProvider } from '@dongkseo/store';

// type: 'json'이면 내부에서 @dongkseo/store-json을 동적 import → createJsonStoreProvider(dataDir)
const store = await createStoreProvider({ type: 'json', dataDir: './.data' });

await store.conversation.appendMessage(conversationId, message);
const history = await store.conversation.getHistory(conversationId);
```

직접 인스턴스화도 가능하다 (`src/index.ts`의 실제 시그니처):

```ts
import { createJsonStoreProvider } from '@dongkseo/store-json';

const provider = createJsonStoreProvider('./.data'); // dataDir 하위에 JSON 파일 생성
await provider.conversation.appendMessage(conversationId, message);

// 단일 store만 필요하면 클래스를 직접 쓴다
import { TreeConversationStoreJson } from '@dongkseo/store-json';
const tree = new TreeConversationStoreJson('./.data');
const entryId = await tree.appendEntry(conversationId, entry);
```

## API 표면 (소스 안 열고 타입만)

`index.ts`는 store별로 그룹핑돼 있고 파일 맨 위에 **섹션 맵 주석**이 있다. 정확한 시그니처가 필요하면
구현 본문 대신 **signatures 모드**로만 읽어라:

```
ctx_read(path="packages/store-json/src/index.ts",        mode="map")          # 전체 export 목록
ctx_read(path="packages/store-json/src/conversation.ts", mode="signatures")
ctx_read(path="packages/store-json/src/session-tree.ts", mode="signatures")
```

어떤 파일에 뭐가 있는지는 `src/index.ts` 상단 주석 맵을 먼저 보면 된다.
각 store가 구현하는 계약 타입은 `@dongkseo/contracts`의 `./store`·`./transcript`·`./session-tree`에 있다.

## 유지보수 (drift 방지)

- 이 README = **목적·개념·레시피** 만. 거의 안 변하므로 손으로 관리.
- **API 정본은 각 소스의 TSDoc** (`/** … */`). API가 바뀌면 코드 옆 TSDoc만 고치면 됨 — 여기 표는 복제하지 말 것.
- 새 store를 export하면 `index.ts` 상단 섹션 맵에 한 줄만 추가.

## Tests

```bash
cd packages/store-json && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework.
