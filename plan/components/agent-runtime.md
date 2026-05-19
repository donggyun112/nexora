# agentkit — 에이전트 런타임 facade

플랫폼의 **단일 가장 중요한 컴포넌트**. 모든 다른 컴포넌트(tenant, budget, Skills, tools, audit)가 이 facade를 통과한다.

## 정체

OpenAI Agents SDK 스타일의 ergonomics를 Go로 구현한 **얇은** facade. 자체 에이전트 프레임워크가 아니라 thin wrapper:

```
anthropic-sdk-go + openai-go + mcp-go + temporalio/sdk-go + instructor-go
   └─── agentkit (얇은 facade, ~2000 LOC) ─── 모든 컴포넌트가 통과
```

## API 모양 (개념)

```go
package agentkit

type Config struct {
    Name          string
    Instructions  string                  // Skills resolver에서 받음
    Model         ModelRef                // tenant 모델 라우팅 통과
    Tools         []Tool                  // tool allowlist 적용된 것만
    Handoffs      []*Agent                // child workflow로 실행
    Guardrails    Guardrails              // input/output 미들웨어
    Budget        BudgetGate              // pre-call enforcer
    Audit         AuditWriter             // 모든 turn 기록
    MaxTurns      int
    Architecture  ArchKind                // ReAct / PlanExecute / Loop / DeepResearch
}

type Agent struct { ... }

// 워크플로 안에서 호출
func Run(ctx workflow.Context, agent *Agent, input string) (Result, error)

// 도구 등록 (함수 시그니처 → JSON Schema 자동)
func ToolFn[Args any, Result any](name, desc string, fn func(context.Context, Args) (Result, error)) Tool

// 핸드오프 (Temporal child workflow)
func Handoff(target *Agent, context HandoffContext) Action
```

## 핵심 메서드

```go
agent := agentkit.New(agentkit.Config{
    Name:         "support-tier1",
    Instructions: skill.Resolve(ctx, tenant, "support-tier1"),
    Model:        modelRouter.For(tenant),
    Tools:        toolPolicy.Filter(ctx, tenant, allTools),
    Handoffs:     []*agentkit.Agent{billingAgent, refundAgent},
    Budget:       budgetGate.For(ctx, tenant, "support-tier1"),
    Audit:        auditLog.WithTenant(ctx, tenant),
    MaxTurns:     12,
    Architecture: arch.ReAct,
})

result, err := agentkit.Run(workflowCtx, agent, input)
```

## 내부 구조

```
agentkit/
├── agent.go              ← Config / Agent 타입
├── run.go                ← Run() 메인 진입
├── arch/
│   ├── react.go          ← ReAct 전략 (think→tool→observe)
│   ├── plan_execute.go   ← Plan 단계 + 순차 실행
│   ├── loop.go           ← 단순 반복 (정해진 횟수)
│   └── deep_research.go  ← Deep Research 다단계
├── tools/
│   ├── registry.go       ← tool 컬렉션 관리
│   ├── schema.go         ← 함수 시그니처 → JSON Schema (reflection + instructor-go)
│   └── exec.go           ← 도구 실행 + audit hook + budget hook
├── handoff/
│   └── handoff.go        ← child workflow 트리거
├── guardrails/
│   ├── input.go          ← 호출 전 검증
│   └── output.go         ← 응답 후 검증
├── llm/
│   ├── provider.go       ← Anthropic/OpenAI 추상화 인터페이스
│   ├── anthropic.go      ← anthropic-sdk-go wrapper
│   ├── openai.go         ← openai-go wrapper
│   └── fallback.go       ← 에러 분류 + 자동 대체 provider
├── streaming/
│   └── stream.go         ← SSE 이벤트 발행
└── result.go             ← Result 타입, 메타데이터
```

## ReAct 전략 의사코드

```go
func (s *ReActStrategy) Run(ctx workflow.Context, agent *Agent, input string) (Result, error) {
    history := []Message{{Role: "system", Content: agent.Instructions}, {Role: "user", Content: input}}
    
    for turn := 0; turn < agent.MaxTurns; turn++ {
        // 1) input guardrails
        if err := agent.Guardrails.CheckInput(ctx, history); err != nil { return Result{}, err }
        
        // 2) budget gate (activity)
        if !agent.Budget.Allow(ctx, estimateCost(history)) {
            return Result{Reason: "budget_blocked"}, nil
        }
        
        // 3) LLM 호출 (activity, 재시도 자동)
        var resp LLMResponse
        workflow.ExecuteActivity(ctx, activities.CallLLM, history).Get(ctx, &resp)
        history = append(history, resp.Message)
        
        // 4) output guardrails
        if err := agent.Guardrails.CheckOutput(ctx, resp); err != nil { return Result{}, err }
        
        // 5) audit
        agent.Audit.RecordTurn(ctx, turn, resp)
        
        // 6) 종료 조건
        if len(resp.ToolCalls) == 0 {
            return Result{FinalMessage: resp.Message, Turns: turn + 1}, nil
        }
        
        // 7) 병렬 tool 실행 (activity들)
        toolResults := executeToolsParallel(ctx, agent, resp.ToolCalls)
        for _, tr := range toolResults {
            history = append(history, tr.AsMessage())
        }
        
        // 8) handoff 요청? → child workflow
        if handoff := detectHandoff(resp); handoff != nil {
            return executeChildWorkflow(ctx, handoff, history)
        }
    }
    return Result{Reason: "max_turns_reached"}, nil
}
```

## 도구 자동 스키마 추출

```go
type SearchArgs struct {
    Query  string `json:"query" jsonschema:"description=검색어"`
    Limit  int    `json:"limit,omitempty" jsonschema:"default=10,maximum=50"`
}

func searchKB(ctx context.Context, args SearchArgs) (SearchResult, error) { ... }

// 등록 — JSON Schema는 reflection으로 자동 생성
tool := agentkit.ToolFn("search_kb", "지식베이스 검색", searchKB)
```

내부에서 `instructor-go` + 자체 reflection으로 OpenAI/Anthropic 도구 정의 양쪽 포맷 생성.

## 멀티프로바이더 추상화

```go
type Provider interface {
    Call(ctx context.Context, req Request) (Response, error)
    Stream(ctx context.Context, req Request) (StreamReader, error)
    SupportsToolUse() bool
    SupportsStreaming() bool
}

// 구현체
type AnthropicProvider struct { client *anthropic.Client }
type OpenAIProvider struct { client *openai.Client }

// 스마트 fallback
type FallbackProvider struct {
    primary   Provider
    secondary Provider
    classifier ErrorClassifier  // 429, 5xx, timeout 분류
}
```

## Temporal 통합

- `Run()` 자체는 **워크플로 함수 안에서만** 호출 가능 (deterministic)
- 모든 LLM/tool 호출은 **activity로 위임** (자동 재시도, heartbeat, 취소)
- handoff는 **child workflow** (영속·재시도)
- 시그널 수신 (사용자 interrupt, 휴먼 응답)은 `workflow.GetSignalChannel` 활용

## Scope 통제 (★ 가장 중요)

agentkit이 두 번째 풀 에이전트 프레임워크가 되지 않게:

- **여기 안 넣음**: 카탈로그 관리, manifest 저장, tenant 정책 로직, eval, Skills 라이프사이클 자체
- **여기 넣음**: 위 컴포넌트들을 1급 파라미터로 받아서 ReAct 루프에 끼우는 일

scope creep 감지 룰: agentkit이 다른 컴포넌트의 책임을 알기 시작하면 stop. facade는 받아쓰고 위임.

## 관련 ADR

- [ADR-009: 자작 agentkit](../adrs/adr-009-self-built-agentkit.md)
