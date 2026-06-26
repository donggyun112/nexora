# @dongkseo/store-memory

**Stability: experimental** · `pnpm add @dongkseo/store-memory`

> 이 파일은 에이전트(사람·LLM)가 **소스를 열지 않고도** 이 패키지를 쓸 수 있게 하는 오리엔테이션 문서다.
> 정확한 API 타입은 "API 표면" 섹션의 방법으로 `signatures`만 읽어라 — 본문을 베끼지 말 것.

## 무엇인가 / 무엇이 아닌가

에이전트의 **연상 기억(associative memory)** 을 담는 인메모리 그래프 패키지다. Key(개념) ↔ Memory(사실)
의 N:M 이분 그래프 위에서 임베딩 기반 의미 검색·2-hop 연상·시간 감쇠·버전 체인을 제공한다.

- ✅ 담는 것: `MemoryGraph` (remember/recall), 임베딩 프로바이더 팩토리(`createOpenAIEmbedding`,
  `createOllamaEmbedding`), 벡터 헬퍼(`cosineSim` …), 관련 타입
- ❌ 안 담는 것: 영속화(디스크/DB) — 상태는 프로세스 메모리에만 있고 `export()`/`data` 옵션으로만
  주고받는다. 임베딩 모델 자체도 안 담는다(외부 API/Ollama 호출 또는 직접 주입)
- ⚠️ **optional 패키지**. 기억이 필요한 에이전트만 의존하면 된다.

의존 방향은 **store-memory → contracts** 단방향(타입만). store-memory를 의존하는 쪽은 기억을 쓰는 에이전트/툴.

## 핵심 개념

| 개념 | 무엇 | 대표 export |
| --- | --- | --- |
| **MemoryGraph** | 기억 그래프의 진입점. remember로 저장, recall로 의미 검색 | `MemoryGraph`, `MemoryGraphOptions` |
| **Memory / Key** | 사실(Memory)과 개념(Key)을 잇는 N:M 노드 | `Memory`, `MemoryKey`, `MemoryKeyLink`, `KeyType` |
| **RecallResult** | recall 결과. 점수·depth·hop(1=직접, 2=연상)·매칭 경로 | `RecallResult` |
| **EmbeddingProvider** | 텍스트→벡터 변환 계약. 직접 구현하거나 팩토리 사용 | `EmbeddingProvider` |
| **Embedding 팩토리** | OpenAI API / 로컬 Ollama용 프로바이더 생성기 | `createOpenAIEmbedding`, `createOllamaEmbedding` |
| **Vector 헬퍼** | 코사인 유사도 계산 순수 함수 | `cosineSim`, `batchCosineSim` |
| **GraphData** | 그래프 전체 스냅샷(영속화 복원용) | `GraphData`, `export()` |

특징: 2-hop 연상 검색(Newton → apple → fruit → strawberry), depth 강화(자주 떠올리면 강해짐),
시간 감쇠(얕은 기억은 흐려지고 깊은 기억은 유지), supersede 체인(덮어쓰기 대신 버전 관리),
중복 감지(cosine ≥ 0.90 → supersede), 키 병합(cosine ≥ 0.85 → 개념 재사용).

## 사용 레시피

OpenAI 임베딩으로 기억을 저장·연상한다 (`src/index.ts` TSDoc 기준, 실제 동작 코드):

```ts
import { MemoryGraph, createOpenAIEmbedding } from '@dongkseo/store-memory';

const graph = new MemoryGraph({
  embedding: createOpenAIEmbedding({ apiKey: process.env.OPENAI_API_KEY }),
});

await graph.remember('User prefers TypeScript', ['programming', 'preference']);
const results = await graph.recall('What language does the user like?');
// results[0].content === 'User prefers TypeScript', .hop === 1
```

로컬 Ollama로 키 없이 돌린다:

```ts
import { MemoryGraph, createOllamaEmbedding } from '@dongkseo/store-memory';

const graph = new MemoryGraph({
  embedding: createOllamaEmbedding({ model: 'nomic-embed-text' }), // 기본 http://localhost:11434
});
```

임베딩 프로바이더를 직접 주입한다 (테스트/커스텀 모델, `src/__tests__` 기준):

```ts
const graph = new MemoryGraph({
  embedding: {
    embed: async (text) => /* number[] 반환 */,
    embedBatch: async (texts) => /* number[][] 반환 */,
  },
});
```

스냅샷 내보내기/복원 (영속화는 호출자 몫):

```ts
const snapshot = graph.export();                                  // GraphData
const restored = new MemoryGraph({ embedding, data: snapshot });  // 복원
```

## API 표면 (소스 안 열고 타입만)

`index.ts` 맨 위에 **섹션 맵 주석**이 있다. 정확한 시그니처가 필요하면 구현 본문 대신
**signatures 모드**로만 읽어라:

```
ctx_read(path="packages/store-memory/src/memory-graph.ts",        mode="signatures")
ctx_read(path="packages/store-memory/src/embedding-providers.ts", mode="signatures")
ctx_read(path="packages/store-memory/src/types.ts",               mode="signatures")
ctx_read(path="packages/store-memory/src/index.ts",               mode="map")   # 전체 export 목록
```

어떤 파일에 뭐가 있는지는 `src/index.ts` 상단 주석 맵을 먼저 보면 된다.

## 유지보수 (drift 방지)

- 이 README = **목적·개념·레시피** 만. 거의 안 변하므로 손으로 관리.
- **API 정본은 각 소스의 TSDoc** (`/** … */`). API가 바뀌면 코드 옆 TSDoc만 고치면 됨 — 여기 표는 복제하지 말 것.
- 새 모듈을 export하면 `index.ts` 상단 섹션 맵에 한 줄만 추가.

## Tests

```bash
cd packages/store-memory && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
