# @dongkseo/conversation

**Stability: advanced** · `pnpm add @dongkseo/conversation`

> 이 파일은 에이전트(사람·LLM)가 **소스를 열지 않고도** 이 패키지를 쓸 수 있게 하는 오리엔테이션 문서다.
> 정확한 API 타입은 "API 표면" 섹션의 방법으로 `signatures`만 읽어라 — 본문을 베끼지 말 것.

## 무엇인가 / 무엇이 아닌가

여러 에이전트가 한 사람과 **하나의 채널을 공유**할 때, 모두가 동시에 답하지 않고
사람처럼 그룹챗에서 순서를 지키게 하는 **턴테이킹 프로토콜** 패키지다.

- ✅ 담는 것: 대화방 상태(`ConversationRoom`), 4단계 턴 프로토콜(`TurnManager`), 초저가 "내가 답할까?" 판단(`evaluateAgent`/`evaluateAll`), 다자 회의 진행(`MeetingOrchestrator`)
- ❌ 안 담는 것: LLM 호출 구현, 도구 실행 엔진, 영속 저장소 구현, HTTP/Discord 어댑터 — 그건 `adapters`/`tools`/`store-*` 몫. 이 패키지는 그 위에서 **누가·언제 말하는지** 만 조율한다.

의존 방향은 `conversation → contracts`, `conversation → tools` 단방향. `LLMProvider`·`AgentCard` 같은 계약은 주입받아 쓴다.

## 핵심 개념

| 개념 | 무엇 | 대표 export |
| --- | --- | --- |
| **ConversationRoom** | 한 채널의 공유 상태(참여자·히스토리·현재 응답자) | `ConversationRoom`, `RoomParticipant`, `RoomMessage` |
| **TurnManager** | 4단계 프로토콜(evaluate → select → respond → follow-up) | `TurnManager`, `TurnManagerOptions`, `TurnResult` |
| **Evaluate** | 토큰 ~50개짜리 "내가 답할까?" 이진 판단 + 신뢰도 | `evaluateAgent`, `evaluateAll`, `EvaluationResult` |
| **MeetingOrchestrator** | 마스터가 진행하는 다자 회의(발언권·정리·스트리밍) | `MeetingOrchestrator`, `MeetingEvent`, `MeetingOrchestratorOptions` |
| **Meeting prompts** | 회의 프롬프트 템플릿과 치환 헬퍼 | `DEFAULT_MEETING_PROMPTS`, `interpolate`, `MeetingPromptTemplates` |

## 사용 레시피

방을 만들고 에이전트를 넣은 뒤, 한 메시지마다 한 명만 답하게 한다 (`examples/personal-assistant` 기준, 실제 동작 코드):

```ts
import { ConversationRoom, TurnManager } from '@dongkseo/conversation';

const room = new ConversationRoom('session');
room.join({
  card: assistantCard,        // @dongkseo/contracts 의 defineAgent 결과
  llm: myLLMProvider,         // LLMProvider 주입
  respondPrompt: 'You are a helpful personal assistant. Be concise.',
});

const tm = new TurnManager({ maxResponders: 1 }); // 메시지당 1명만 응답

// 들어온 사용자 메시지를 방에 넣고, 누가 답할지 프로토콜에 맡긴다
const rmsg = room.addUserMessage(msg.content, msg.displayName);
const result = await tm.handleMessage(room, rmsg);
const content = result.responses[0]?.content ?? '(no response)';
```

여러 에이전트가 함께 있을 때는 `room.join(...)`을 더 호출하면 `TurnManager`가 누가 말할지 정한다.
다자 **회의**가 필요하면 `MeetingOrchestrator(room, meetingManager)`로 마스터 진행자가 발언권을 돌린다
(`meetingManager`는 `@dongkseo/tools` 제공):

```ts
import { MeetingOrchestrator } from '@dongkseo/conversation';

const orchestrator = new MeetingOrchestrator(room, meetingMgr);
const summary = await orchestrator.runMeeting('master', '릴리스 일정', ['coder', 'reviewer']);
```

더 큰 예제: [`examples/personal-assistant`](../../examples/personal-assistant) (단일 응답 채널), [`examples/e2e-demo`](../../examples/e2e-demo) (TurnManager + MeetingOrchestrator).

## API 표면 (소스 안 열고 타입만)

`index.ts` 맨 위에 **섹션 맵 주석**이 있다. 정확한 시그니처가 필요하면 구현 본문 대신 **signatures 모드**로만 읽어라:

```bash
ctx_read(path="packages/conversation/src/room.ts",                 mode="signatures")
ctx_read(path="packages/conversation/src/turn-manager.ts",         mode="signatures")
ctx_read(path="packages/conversation/src/evaluate.ts",             mode="signatures")
ctx_read(path="packages/conversation/src/meeting-orchestrator.ts", mode="signatures")
ctx_read(path="packages/conversation/src/index.ts",                mode="map")   # 전체 export 목록
```

어떤 파일에 뭐가 있는지는 `src/index.ts` 상단 주석 맵을 먼저 보면 된다.

## 유지보수 (drift 방지)

- 이 README = **목적·개념·레시피** 만. 거의 안 변하므로 손으로 관리.
- **API 정본은 각 소스의 TSDoc** (`/** … */`). API가 바뀌면 코드 옆 TSDoc만 고치면 됨 — 여기 표는 복제하지 말 것.
- 새 모듈을 export하면 `index.ts` 상단 섹션 맵에 한 줄만 추가.

## Tests

```bash
cd packages/conversation && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework.
