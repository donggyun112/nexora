# budget gate

플랫폼의 가장 강한 차별점 중 하나. **Pre-execution enforcement** — 알람 아니라 차단.

## 책임

- 모든 LLM 호출 / tool 호출 / sandbox 실행 **직전**에 통과 검사
- 단위: `agent_id × tenant_id × time_window`
- 모드: hard block / warn / log-only (테넌트 설정)
- 일/월/시간 단위 윈도우 + 누적 리셋 cron 워크플로

## 왜 pre-execution

- 산업 사고 ($47K runaway, $4,200 weekend) 모두 "monitoring without enforcement"가 원인
- 알람은 후속 — 호출은 이미 발생, 토큰 이미 태움
- pre-call gate는 **호출 자체를 막음**

## API

```go
package budget

type Decision int
const (
    Allow Decision = iota
    Warn           // 호출은 하되 SSE에 warning 이벤트
    Block          // 호출 금지, 에러 반환
)

type Gate interface {
    Check(ctx context.Context, req Request) (Decision, error)
    Charge(ctx context.Context, charge Charge) error  // 호출 후 실제 비용 기록
}

type Request struct {
    Operation     OpKind   // llm_call / tool_call / sandbox_exec
    EstimatedCost Cents    // pre-call 추정치
    Provider      string   // anthropic / openai / e2b ...
    Model         string
}

type Charge struct {
    Operation   OpKind
    ActualCost  Cents
    Tokens      int
    Provider    string
    Model       string
    RunID       string
}
```

## 데이터 모델

```sql
-- 한도 설정 (tenant × agent 별)
CREATE TABLE budgets (
    tenant_id   TEXT NOT NULL,
    agent_id    TEXT,         -- NULL = 테넌트 전체 한도
    window      TEXT NOT NULL,  -- 'daily' / 'monthly' / 'hourly'
    limit_cents BIGINT NOT NULL,
    mode        TEXT NOT NULL,  -- 'block' / 'warn' / 'log'
    PRIMARY KEY (tenant_id, agent_id, window)
);

-- 누적 사용량 (Redis가 hot path, Postgres가 source of truth)
CREATE TABLE budget_usage (
    tenant_id      TEXT NOT NULL,
    agent_id       TEXT NOT NULL,
    window         TEXT NOT NULL,
    window_started TIMESTAMPTZ NOT NULL,
    used_cents     BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, agent_id, window, window_started)
);
```

## Redis 백드 hot path

```
key: budget:{tenant}:{agent}:{window}:{window_start}
value: used_cents (INCRBY)
TTL: window 길이 + 여유
```

- pre-call: Redis에서 GET → 한도 비교 → INCRBY 추정치
- post-call: 차이만큼 보정 INCRBY (actual - estimated)
- 주기적 Postgres flush (Redis가 source of truth 아님 — Postgres가 진실)

## 강제 시점

```go
// agentkit이 LLM 호출 전
func (s *ReActStrategy) callLLM(ctx workflow.Context, history []Message) (LLMResponse, error) {
    estimate := estimateCost(history, agent.Model)
    
    var decision budget.Decision
    workflow.ExecuteActivity(ctx, activities.CheckBudget, budget.Request{
        Operation:     budget.LLMCall,
        EstimatedCost: estimate,
        Provider:      agent.Model.Provider,
    }).Get(ctx, &decision)
    
    switch decision {
    case budget.Block:
        return LLMResponse{}, ErrBudgetExceeded
    case budget.Warn:
        emitSSE(ctx, "budget.warning", budgetWarning(...))
    }
    
    // 호출 진행
    resp, err := callLLMActivity(ctx, history)
    
    // 실제 비용 기록
    workflow.ExecuteActivity(ctx, activities.ChargeBudget, budget.Charge{
        ActualCost: resp.Cost,
        Tokens:     resp.Tokens,
    })
    
    return resp, err
}
```

## 윈도우 리셋

`BudgetCycleWorkflow` (Temporal cron):
- 일 단위: 매일 00:00 UTC
- 월 단위: 매월 1일
- 시간 단위: 매시 0분

리셋 작업:
- 새 `budget_usage` 행 생성 (이전 행 보존, 감사용)
- Redis 키 새 TTL로 재설정
- 사용량 리포트 발송 (Postmark, 옵션)

## 추정 비용 계산

```go
func estimateCost(history []Message, model ModelRef) Cents {
    // 입력 토큰 = history 토큰 합
    inputTokens := tokensFor(history, model.Tokenizer)
    
    // 출력 토큰 추정 = max_tokens or heuristic
    outputTokens := model.DefaultMaxOutput
    
    return model.PriceInput(inputTokens) + model.PriceOutput(outputTokens)
}
```

토크나이저 — 각 provider별 tiktoken/Anthropic tokenizer 자체 구현 또는 라이브러리.

## 테넌트 한도 설정

```
PUT /v1/tenants/{id}/budgets
Body:
  {
    "limits": [
      {"agent_id": null, "window": "monthly", "limit_cents": 50000, "mode": "block"},
      {"agent_id": "support", "window": "daily", "limit_cents": 1000, "mode": "warn"}
    ]
  }
```

## 관찰성

- OTel metric: `budget.charge.cents` (tenant_id, agent_id, model, op_kind 라벨)
- OTel metric: `budget.decisions` (decision 라벨)
- Langfuse: 매 LLM 호출의 cost 자동 첨부
- 알람: 한도의 80% 도달 시 Slack/이메일
