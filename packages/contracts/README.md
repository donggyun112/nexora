# @dongkseo/contracts

**Stability: stable** · `pnpm add @dongkseo/contracts`

> 이 파일은 에이전트(사람·LLM)가 **소스를 열지 않고도** 이 패키지를 쓸 수 있게 하는 오리엔테이션 문서다.
> 정확한 API 타입은 "API 표면" 섹션의 방법으로 `signatures`만 읽어라 — 본문을 베끼지 말 것.

## 무엇인가 / 무엇이 아닌가

Nexora 전체가 공유하는 **타입·인터페이스 정의 패키지**다. 런타임 로직은 거의 없고,
다른 패키지(`core`, `fleet`, `adapters` …)가 의존하는 **계약(contract)** 만 담는다.

- ✅ 담는 것: 타입, 인터페이스, 소수의 *순수* 헬퍼/팩토리(`defineAgent`, `topic`, `textResult` …)
- ❌ 안 담는 것: 실행 엔진, I/O, 저장소 구현, LLM 호출 — 그건 `core`/`store-*`/`adapters` 몫

의존 방향은 항상 **다른 패키지 → contracts** 단방향. contracts는 아무에게도 의존하지 않는다.

## 핵심 개념

| 개념 | 무엇 | 대표 export |
|------|------|-------------|
| **AgentCard** | 에이전트 한 개의 선언(이름·아키텍처·도구·구독/발행 topic) | `defineAgent`, `AgentDefinition`, `AgentCard` |
| **Capability** | 에이전트가 제공/요구하는 능력 계약 | `defineCapability`, `CapabilityRef` |
| **Topic (pub/sub)** | 에이전트 간 메시지 라우팅 키 | `topic`, `matchTopic`, `Topics` |
| **Tool result** | 도구 실행 결과 표준 형태 | `textResult`, `errorResult`, `suspendResult` |
| **Oracle** | 정책/제약 기반 런타임 결정 | `NexoraOracle`, `OracleDecision`, `OracleContext` |
| **Worker / Runtime** | 워커 등록·실행·syscall 프로토콜 | `WorkerRegistry`, `RuntimeState`, `RetrySyscall` |
| **Store / Transcript** | 영속화·대화 기록 백엔드 계약 | `StoreBackend`, `TranscriptStore`, `SessionTree` |
| **Effect ledger** | 외부 효과의 실행 의도·완료 결과·run lease/fencing 계약 | `EffectLedger`, `EffectRecord` |
| **Tenancy** | 멀티테넌트 스코프 | `createTenantAgentScope`, `DEFAULT_TENANT` |

## 사용 레시피

에이전트를 선언한다 (`examples/auto-work-flow` 기준, 실제 동작 코드):

```ts
import { defineAgent, topic } from '@dongkseo/contracts';

const coder = defineAgent({
  name: 'coder',
  version: '0.1.0',
  desc: 'Writes and executes code. Main workhorse.',
  architecture: 'react',                                  // 실행 아키텍처
  tools: ['read', 'grep', 'edit', 'Bash', 'write', 'delegate'],
  capabilities: ['code-execution', 'file-editing', 'debugging'],
  subscribes: [topic('coder.requested')],                 // 받을 메시지
  publishes: [topic('coder.completed')],                  // 낼 메시지
});
```

도구 핸들러 결과는 헬퍼로 만든다:

```ts
import { textResult, errorResult, suspendResult } from '@dongkseo/contracts';

return textResult('완료했습니다');           // 정상 결과
return errorResult('파일을 찾을 수 없음');   // 오류 결과
return suspendResult({ /* 재개 정보 */ });   // 일시중단(휴먼인더루프 등)
```

더 큰 예제: [`examples/auto-work-flow`](../../examples/auto-work-flow) (PM→Coder→Reviewer 멀티에이전트, API 키 불필요).

## API 표면 (소스 안 열고 타입만)

`index.ts`는 도메인별로 그룹핑돼 있고 파일 맨 위에 **섹션 맵 주석**이 있다. 정확한 시그니처가 필요하면
구현 본문 대신 **signatures 모드**로만 읽어라:

```
ctx_read(path="packages/contracts/src/define.ts",  mode="signatures")
ctx_read(path="packages/contracts/src/oracle.ts",  mode="signatures")
ctx_read(path="packages/contracts/src/effect-ledger.ts", mode="signatures")
ctx_read(path="packages/contracts/src/index.ts",   mode="map")   # 전체 export 목록
```

어떤 파일에 뭐가 있는지는 `src/index.ts` 상단 주석 맵을 먼저 보면 된다.

## 유지보수 (drift 방지)

- 이 README = **목적·개념·레시피** 만. 거의 안 변하므로 손으로 관리.
- **API 정본은 각 소스의 TSDoc** (`/** … */`). API가 바뀌면 코드 옆 TSDoc만 고치면 됨 — 여기 표는 복제하지 말 것.
- 새 모듈을 export하면 `index.ts` 상단 섹션 맵에 한 줄만 추가.

## Tests

```bash
cd packages/contracts && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
