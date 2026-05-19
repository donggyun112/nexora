# ADR-009: 자작 agentkit (OpenAI Agents SDK 비채택)

**상태**: Accepted
**날짜**: 2026-05-13

## 컨텍스트

에이전트 런타임 (ReAct 루프 본체) — OpenAI Agents SDK의 ergonomics가 매력적이지만 Go 공식판이 없음. 우리는 멀티테넌트 + budget gate + Skills 라이프사이클 + architecture pluggability를 1급으로 통합해야 함.

## 검토한 옵션

- **자작 agentkit** (Anthropic+OpenAI SDK + Temporal + MCP 위에 얇은 facade)
- **nlpodyssey/openai-agents-go** (OpenAI Agents SDK의 비공식 Go 포팅)
- **Genkit Go** (Google, flows+tools+RAG+OTel 번들)
- **Eino** (ByteDance, Go-native LLM 앱 프레임워크)
- **LangChainGo**
- **Python 사이드카가 에이전트 런타임을 호스팅** (Go는 컨트롤만)

## 결정

**자작 agentkit** facade. anthropic-sdk-go + openai-go + modelcontextprotocol/go-sdk + temporalio/sdk-go + instructor-go 위에 ~2000 LOC.

이유:
1. **훅이 1급**: 매 LLM 호출 직전에 tenant policy + budget gate + audit + Skills resolve를 끼워야 함. 외부 프레임워크는 이 깊이의 훅을 노출하지 않음 — 매번 싸움.
2. **OpenAI Agents SDK Go 공식판 없음**: 비공식 포팅(nlpodyssey)은 1인 메인테이너 리스크.
3. **Temporal과 통합 깊음**: handoff = child workflow, session = workflow state, signal = interrupt — facade 안에서 자연스럽게 매핑.
4. **scope 통제 가능**: facade는 2000 LOC 한도, 다른 컴포넌트로의 의존을 받아쓰기만. 두 번째 풀 프레임워크 안 됨.
5. **5년 유지보수**: 우리가 짠 코드만 책임. 외부 프레임워크 churn 영향 X.

## API 모양 (개념)

```go
agent := agentkit.New(agentkit.Config{
    Name:         "support-tier1",
    Instructions: skill.Resolve(ctx, tenant, "support-tier1"),
    Model:        modelRouter.For(tenant),
    Tools:        toolPolicy.Filter(ctx, tenant, allTools),
    Handoffs:     []*agentkit.Agent{billingAgent},
    Budget:       budgetGate.For(ctx, tenant, "support-tier1"),
    Audit:        auditLog.WithTenant(ctx, tenant),
    MaxTurns:     12,
    Architecture: arch.ReAct,
})

result, err := agentkit.Run(workflowCtx, agent, input)
```

## OpenAI Agents SDK에서 복제할 패턴 (90%)

- Agent 구조체 (instructions·model·tools·handoffs·guardrails)
- 함수 시그니처 → JSON Schema 자동 (`instructor-go` + reflection)
- Handoffs (Agents SDK보다 강력 — Temporal child workflow)
- Guardrails (input/output 미들웨어)
- 자동 tracing (OTel span)
- Sessions (Temporal workflow state — Agents SDK는 in-memory, 우리는 영속)
- Streaming (anthropic-sdk-go / openai-go 와이어링)
- 구조화 출력 (`instructor-go`)
- Lifecycle hooks
- max_turns 루프 제어
- 멀티프로바이더 추상

## 못 받는 것

- OpenAI hosted Code Interpreter / File Search / Web Search (대신 MCP / E2B로)
- Agents SDK hosted tracing 대시보드 (대신 Langfuse)
- Pydantic 자동 검증 ergonomics (대신 `instructor-go`)
- OpenAI 매주 추가하는 신기능 D-0 (수주 lag, agentkit이 우회)

## Effort

| 항목 | 라인 수 | 기간 |
|---|---|---|
| Agent / Tool / Handoff 타입 + Run() | ~800 | 1주 |
| ReAct + Plan-Execute 전략 | ~500 | 0.5주 |
| Streaming + 구조화 출력 | ~400 | 0.5주 |
| Guardrails + Lifecycle hooks + Tracing | ~300 | 0.5주 |
| Provider abstraction + smart fallback | (llm 패키지 별도, ~500) | 1주 |
| **합계** | **~2500 LOC** | **~3주** |

## 결과

긍정:
- 모든 정책 훅이 1급
- Temporal 영속성과 자연 결합
- scope 제어 가능
- 5년 유지보수 비용 측정 가능

부정:
- 새 LLM 기능 lag 수주
- LiteLLM 같은 통합 LLM 추상 없으니 provider 추가 시 코드 작성
- agentkit이 두 번째 풀 프레임워크 되지 않게 규율 필요

## scope creep 방지 룰

- 카탈로그 관리 / manifest 저장 / tenant 정책 로직 / eval / Skills 라이프사이클 자체는 **여기 안 넣음**
- 위 컴포넌트들을 1급 파라미터로 받아서 ReAct 루프에 끼우는 일만 함
- 다른 컴포넌트의 책임을 알기 시작하면 stop

## 안 가는 길

- **nlpodyssey/openai-agents-go**: 1인 메인테이너 리스크 + Temporal 통합 정합성 불확실
- **Genkit Go**: Google AI 색깔 강함, ReAct 외 arch swap 안 됨
- **Eino**: ByteDance 종속, 커뮤니티 작음
- **Python 사이드카가 에이전트 호스팅**: cross-language 디버깅 = 최악의 디버깅 케이스

## 관련

- [components/agent-runtime.md](../components/agent-runtime.md)
- [stack/go-libraries.md](../stack/go-libraries.md)
