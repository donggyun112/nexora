# ADR-002: Nexora의 정체성 — 단일 에이전트 런타임 (ReAct 강화, 멀티에이전트는 툴로 접기)

**상태**: Proposed (방향 확정, 구현 미착수 — 2026-07-13)
**날짜**: 2026-07-13
**범위**: `@dongkseo/architectures`, `@dongkseo/core`, `@dongkseo/tools`, `@dongkseo/conversation`(강등), `@dongkseo/gateway`

> [ADR-001](adr-001-tenancy-opt-in.md)이 "멀티테넌트를 근본에서 부가로" 강등한 첫 뺄셈이었다면,
> 이 ADR은 그 뺄셈을 **정체성 수준으로 일반화**한다: "다 되는 프레임워크"에서
> **"단일 에이전트를 프로덕션에서 굴리는 런타임"**으로 좁힌다.
>
> **성격**: 이건 단일 결정이 아니라 서로 맞물린 몇 개의 뺄셈/재배치 + 강화 로드맵이다.

---

## 컨텍스트

Nexora는 "멀티테넌트 · 멀티에이전트 프레임워크"로 출발했다. 그러나 실제로 코드를 깊게
파보면 가치의 무게중심이 **조율(coordination)이 아니라 단일 에이전트의 런타임**에 있다.
이 ADR은 그 관찰을 정체성으로 못 박는다.

### 본질 환원 — 에이전트란 무엇인가

에이전트를 끝까지 환원하면:

```
agent = loop(ReAct) + tools + context
```

- **loop**: LLM을 반복 호출하는 제어 루프 (`architectures/src/react.ts`).
- **tools**: 능력(capability). 파일·exec·검색·delegate 등 (`tools/*`).
- **context**: "지시사항"이 사실 제일 무거운 항 — 시스템프롬프트 + retrieval + memory
  + skills + 툴결과 관리 + **compaction**. 지금 에이전트 품질 대부분이 여기서 나온다.

"나머지"(멀티에이전트 조율, 멀티테넌트 격리)는 **지능이 아니라 스캐폴딩**이다. 지능은
위 triad이고, **엔지니어링 해자는 그 위의 런타임 -ility**들이다: 격리(sandbox),
context 관리, budget, durability(checkpoint/resume), tracing.

### 관찰 (코드로 확인)

- **멀티에이전트가 두 벌로 갈라져 있다.** `ConversationRoom`/`TurnManager`(Case A, 인프로세스)는
  `conversation/src/evaluate.ts:83`에서 `participant.llm.complete(...)`를 직접 부른다 — 참가자가
  `llm`·`card`를 메모리에 들고 있어 transport를 못 탄다. 반면 `delegate`(Case B, 아웃오브프로세스)는
  `tools/src/builtin/delegate.ts`에서 `EventTransport`를 받아 capability로 피어를 wire resolve한다.
  **같은 "협업" 개념의 구현이 두 개.**
- **멀티에이전트의 진짜 효용은 딱 둘** — (1) 컨텍스트 격리, (2) 병렬 fan-out. 둘 다
  **"서브에이전트 스폰 = 툴 하나"**로 표현된다(Claude Code의 Task 툴 방식). 조율 *프레임워크*는
  불필요하고, 조율 *메커니즘*(누가 언제)은 도메인 정책이다.
- **goal은 이미 있으나 수동이다.** `contracts/src/goal.ts` — 골 계층을 시스템프롬프트에 주입하는
  *우선순위 컨텍스트*지 루프를 제어하지 않는다.
- **훅은 있으나 굵다.** `core`의 `AgentMiddleware`는 `beforeExecution`/`afterExecution`(실행 전체)만.
  루프 *안*(per-iteration/LLM/tool) 주입점이 없다. `react.ts:106`은 `for (iteration < maxIterations)`
  + tool 없으면 `done` — **goal-aware 종료가 없다.** (코어 리뷰의 "budget 루프 중 미재체크",
  "compaction 미설정 시 무한 토큰 증가"가 다 여기서 나온다.)
- **auth는 이미 엣지에 있다.** `gateway`의 `createApiKeyAuth`/`createRateLimiter` — 데이터플레인
  런타임에 실로 안 꿰고 엣지에 둔 지금 구조가 맞다.

---

## 결정

### D1. 멀티테넌트 — opt-in 확정 (ADR-001 계승)

격리를 근본에서 부가로. 단일 테넌트 = 제로코스트 기본값. 세부는 ADR-001. README/문서의
"every tenant isolated" 헤드라인은 회수하고, `tenantId`/`namespace`는 **보안 경계가 아니라
일반 스코프 키**(프로젝트/세션 구분)로 재정의한다.

### D2. 멀티에이전트 조율 프레임워크 → 서브에이전트=툴로 접기

- **`delegate`를 프레임워크가 아니라 빌트인 툴로** 취급한다 (이미 절반은 그 모양).
- **`ConversationRoom`/`TurnManager`/`meeting-orchestrator`를 *정체성*에서 뺀다** — 이건
  "멀티페르소나 그룹챗"이라는 특정 *앱 패턴*이지 플랫폼이 아니다. 예제/앱으로 보존하되
  헤드라인·핵심 API에서 내린다.
- 원칙: **멀티에이전트의 유일하게 원칙적인 자리는 goal 셀프리뷰의 fresh-context 평가자**(D4).

### D3. auth/rate-limit/TLS = 엣지 (리버스프록시/gateway), 런타임 미침투

컨트롤플레인 엣지에서 끝낸다. `gateway`가 이미 그 자리. core에 auth를 넣지 않는다.

### D4. 강화 대상 = ReAct 코어. 순서: hooks → goal → deep-research

각 단계가 다음을 정당화(검증)한다.

**(a) Hook 시스템 = 척추 (먼저)**
`react.ts` for-loop 안에 fine-grained lifecycle 훅을 심는다:

```
onIterationStart(state)              context 주입 · drift 감지
onBeforeLLM(messages)                마지막 순간 컨텍스트 조작
onAfterLLM(response)                 실제 usage 회계 → budget 재체크
onBeforeTool(call) → allow|deny|modify   승인 게이트 · ACL · 서브에이전트 스폰 가드
onAfterTool(result)                  결과 후처리 · 리댁션
onStopCheck(state) → continue|stop   goal-aware 종료 (D4-b)
onError(err)                         복구 · 폴백
```

각 훅은 **컨텍스트 변형 · 루프 단락 · 메시지 주입 · 툴 veto** 가능. 이 하나가
기존 middleware/budget/tracing/compaction을 흡수하고, "서브에이전트=툴" 승인 게이트가
꽂히는 자리이며, **mechanism(플랫폼) vs policy(앱)** 경계를 구현한다. 신기능이 아니라
**루프를 견고하게 만드는 리팩터.**
함정: 소비자 없이 추상화 먼저 짓지 말 것 — 5개 실수요(budget 재체크 · compaction 트리거 ·
goal-stop · approval · tracing)에서 훅 포인트를 역추출한다.

**(b) Goal → 능동으로 승격 (첫 소비자)**
goal을 loop state 시민으로 올리고 `onStopCheck`이 종료를 판정 — `maxIterations`-only를
**goal-aware 종료**로 교체(maxIterations는 백스톱 유지). goal이 hook 설계의 첫 실전 시험대.
최소로 유지: 골 문장 + done-eval + 옵션 todo. **HTN 플래너 금지.**

**(c) Deep Research = 셋을 강제하는 forcing function (마지막)**
goal(리서치 목표) + hooks(fan-out/verify 게이트) + 서브에이전트-툴(병렬 소스 읽기) +
compaction(다수 소스 합성)을 동시에 굴린다. `architectures`에 `createDeepResearchArchitecture`를
`createReactArchitecture` 옆에 두거나 앱 예제로. **1·2가 좋았는지 검증하는 용도로 마지막에 짓는다** —
훅/goal로 깔끔히 표현 안 되면 그게 프리미티브를 고칠 신호. 겸사겸사 포폴 데모.

---

## 관통하는 설계 원칙

- **Mechanism은 플랫폼, policy는 애플리케이션.** 플랫폼은 메시지버스·budget enforcer·sandbox·
  turn-taking *메커니즘*을 주고, 앱은 *정책*(persona·allowlist·언제 넘길지)을 준다. OS가 스케줄링
  메커니즘을 주지 앱의 스케줄링 정책을 안 주는 것과 같다. 훅(D4-a)이 이 경계의 구현체.
- **Control plane vs Data plane.** control = gateway(auth/route) · registry(capability 라우팅) ·
  transport · budget 정책. data = core AgentRunner · sandbox. 이미 이 형태로 짜여 있으니 문서를
  이 축으로 재서술한다(packages-map은 기능 나열이라 이 축이 안 보임).
- **Location transparency (액터 모델).** 협업 메커니즘을 로컬/원격에 무관하게 짜면(Erlang/OTP·Akka·
  Orleans) "인프로세스냐 분산이냐"는 코드가 아니라 **배포 바인딩**이 된다. 지금 두 벌인 협업 구현을
  하나의 peer-handle 추상으로 합치는 것이 목표. A vs B *배포* 결정은 로직이 아니라 **에이전트 간
  신뢰·장애·소유 경계**가 가른다.
- **셀프리뷰는 introspection이 아니라 observation에 grounded돼야 한다.** (아래 D4-b 상세)

### goal = "verifiable self-review" (D4-b 상세)

참조: [Claude Code Loop Engineering](https://www.modernweblabs.com/ko/insights/claude-code-loop-engineering)
— 루프 4종(turn/goal/time/proactive). 핵심 교훈: **메인 에이전트가 자기 작업을 자기가 리뷰하는
셀프리뷰를 종료 게이트로 쓰는 건 제일 약하다**(모델이 "다 했다"로 편향 → premature termination).

`onStopCheck`은 단일 boolean이 아니라 **스펙트럼**으로(강한 순서):

1. **결정적 predicate** — 테스트 통과 수 · 점수 임계 · 외부 체크. LLM 없음. "평가자가 주저할
   여지가 없어서" 제일 강하고 쌈. **기본.**
2. **fresh-context 리뷰어 서브에이전트** — 판단이 필요할 때만. "신선한 컨텍스트가 덜 편향되고
   메인 추론에 오염되지 않는다." **이것이 멀티에이전트가 툴로서 유일하게 원칙적으로 값어치하는 자리**
   (컨텍스트 격리로 편향 제거).
3. **메인 에이전트 셀프리뷰** — 최약체. 단독 게이트 금지.

골의 성공기준은 **verifiable하게** 표현(vibes 금지). 셀프리뷰는 관찰(테스트를 실제로 돌림)에
grounded — 프로젝트의 grounded-verification 원칙과 일치.

### 4-loop 택소노미 매핑

| 루프 종류 | Nexora 위치 |
|---|---|
| turn-based / goal-based | `architectures/react.ts` (지금 turn + 크루드 goal cap → D4로 진짜 goal-based) |
| time-based / proactive | `orchestrator` (`CronScheduler`, `WorkflowEngine`) |

조각은 이미 다 있다. **hook 시스템이 이 넷을 하나의 루프 위에서 표현하게 만드는 접착제.**

---

## 근거

- **가치의 무게중심**: 남들(LangGraph·Temporal·Ray·Agents SDK)이 "조율=플랫폼"엔 다 수렴했지만
  **대부분 실행 격리(sandbox)를 회피(punt)한다.** Nexora가 제일 깊게 판 게 하필 거기 — 방어 가능한 해자.
- **정직성**: "다 되는 프레임워크"의 과장된 주장(멀티테넌트 격리·cycle detection·skill scanning)은
  리뷰어가 몇 분 만에 반증한다. 좁히고 정직하게 disclose하는 편이 신뢰를 산다.
- **타이밍**: v0.1, 1.0 동결 전. 더 많은 코드가 조율 프레임워크에 매달리기 전이 저비용 시점.

## 결과

- (+) 정체성이 선명해진다 — "단일 에이전트를 프로덕션에서 굴리는 런타임."
- (+) 강화 투자가 한 곳(ReAct 코어 + 런타임 -ility)으로 집중된다.
- (+) 멀티에이전트가 필요하면 "서브에이전트 툴" 하나로 충분 — 컨텍스트 격리·fan-out 다 됨.
- (+) hook 시스템이 코어 리뷰의 알려진 버그(budget 미재체크·무한 토큰)를 리팩터로 흡수.
- (−) `conversation`/`meeting-orchestrator`(가장 공들인 683 LOC)가 앱 레이어로 강등 — 정체성에선 빠짐.
- (−) hook/goal은 신규 구현 필요(뺄셈이 아니라 코어 추가). 단계적으로.

## 참고

- [ADR-001: Tenancy opt-in](adr-001-tenancy-opt-in.md) — 첫 뺄셈
- [agent-fleet-os.md](../agent-fleet-os.md), [agent-lifecycle.md](../agent-lifecycle.md)
- 코드: `architectures/src/react.ts`(루프), `contracts/src/goal.ts`(수동 goal),
  `core/src/budget-middleware.ts`(굵은 훅), `tools/src/builtin/delegate.ts`(Case B),
  `conversation/src/evaluate.ts`(Case A), `platform/gateway`(엣지 auth)
- 외부: [Claude Code Loop Engineering](https://www.modernweblabs.com/ko/insights/claude-code-loop-engineering)

Part of the [Nexora](../../../README.md) agent runtime.
