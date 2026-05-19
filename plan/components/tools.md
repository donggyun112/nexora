# tools — MCP + delegate + handraise

도구는 3가지 primitive로 단일화. 모든 도구 호출이 같은 정책 게이트를 통과한다.

## 세 가지 primitive

| Primitive | 정체 | 구현 |
|---|---|---|
| **MCP** | 외부/내부 표준 도구 (검색·DB·API 등) | `modelcontextprotocol/go-sdk` |
| **delegate** | 다른 에이전트로 위임 (capability-based) | Temporal child workflow |
| **handraise** | 사람으로 escalate | Temporal signal-wait workflow |

## 통합 인터페이스

```go
package tools

type Tool interface {
    Name() string
    Description() string
    JSONSchema() json.RawMessage     // LLM에 노출할 도구 스펙
    Invoke(ctx context.Context, args json.RawMessage) (Result, error)
}

// 모든 종류의 도구가 같은 인터페이스
type MCPTool struct { ... }
type DelegateTool struct { ... }
type HandraiseTool struct { ... }
```

## 정책 게이트 (모든 도구 호출 통과)

```go
func InvokeTool(ctx context.Context, tool Tool, args json.RawMessage) (Result, error) {
    tenantID := tenant.IDFrom(ctx)
    
    // 1) allowlist 검사
    if !toolPolicy.IsAllowed(ctx, tenantID, tool.Name()) {
        return Result{}, apperr.ToolNotAllowed(tool.Name())
    }
    
    // 2) budget 추정 (도구별 비용 추정치)
    decision := budgetGate.Check(ctx, budget.Request{
        Operation: budget.ToolCall,
        EstimatedCost: tool.EstimatedCost(),
    })
    if decision == budget.Block {
        return Result{}, apperr.BudgetExceeded()
    }
    
    // 3) audit start
    auditID := audit.StartToolCall(ctx, tool.Name(), args)
    
    // 4) OTel span
    ctx, span := tracer.Start(ctx, "tool.invoke")
    defer span.End()
    
    // 5) 실제 invoke
    result, err := tool.Invoke(ctx, args)
    
    // 6) audit finish + actual cost
    audit.FinishToolCall(ctx, auditID, result, err)
    budgetGate.Charge(ctx, budget.Charge{...})
    
    return result, err
}
```

## MCP 통합

```go
import "github.com/modelcontextprotocol/go-sdk/mcp"

type MCPRegistry struct {
    servers map[string]*mcp.Client  // tenant별로 다른 서버 가능
}

func (r *MCPRegistry) Tools(ctx context.Context) ([]tools.Tool, error) {
    tenantID := tenant.IDFrom(ctx)
    var result []tools.Tool
    
    for name, client := range r.serversFor(tenantID) {
        tools, _ := client.ListTools(ctx)
        for _, t := range tools {
            result = append(result, &MCPTool{
                server: name,
                tool:   t,
                client: client,
            })
        }
    }
    return result, nil
}
```

테넌트가 자기 MCP 서버 추가 가능 (BYOMCP):
```sql
CREATE TABLE tenant_mcp_servers (
    tenant_id TEXT NOT NULL,
    name      TEXT NOT NULL,
    url       TEXT NOT NULL,
    auth      JSONB,  -- envelope 암호화
    PRIMARY KEY (tenant_id, name)
);
```

## delegate

```go
delegateTool := tools.Delegate(tools.DelegateConfig{
    Name:        "ask_billing_agent",
    Description: "결제 관련 질문을 billing 전문 에이전트에게 전달",
    TargetAgent: "billing-tier1",
    StateTransfer: tools.PassFullHistory,  // 또는 PassCompressedSummary
})
```

실행 시:
```go
func (d *DelegateTool) Invoke(ctx context.Context, args json.RawMessage) (Result, error) {
    // workflow context 안에서 child workflow 트리거
    var input AgentRunInput
    json.Unmarshal(args, &input.Message)
    input.AgentID = d.TargetAgent
    input.History = currentHistory(ctx)  // state transfer
    
    var result AgentRunResult
    err := workflow.ExecuteChildWorkflow(ctx, workflows.AgentRunWorkflow, input).Get(ctx, &result)
    
    return Result{Content: result.FinalMessage}, err
}
```

장점 — Agents SDK handoff보다 강력:
- 영속 (parent 죽어도 child 계속)
- 재시도 자동
- 취소 전파
- 디버깅 (Temporal Web UI에 child trace)

## handraise

```go
handraiseTool := tools.Handraise(tools.HandraiseConfig{
    Name:        "escalate_to_human",
    Description: "복잡한 케이스는 사람에게 escalate",
    Timeout:     7 * 24 * time.Hour,
    NotifyChannel: "slack:#support-escalations",
})
```

실행 시 별도 workflow:
```go
func HandraiseWorkflow(ctx workflow.Context, in HandraiseInput) (HandraiseResult, error) {
    // 1) 알림 발송 (Slack/이메일)
    workflow.ExecuteActivity(ctx, activities.NotifyEscalation, in)
    
    // 2) 휴먼 응답 대기 (signal)
    var response HumanResponse
    selector := workflow.NewSelector(ctx)
    selector.AddReceive(workflow.GetSignalChannel(ctx, "human_response"),
        func(c workflow.ReceiveChannel, _ bool) { c.Receive(ctx, &response) })
    selector.AddFuture(workflow.NewTimer(ctx, in.Timeout),
        func(workflow.Future) { response = HumanResponse{TimedOut: true} })
    selector.Select(ctx)
    
    // 3) 응답을 에이전트에 리턴 (tool result로)
    return HandraiseResult{Content: response.Message}, nil
}
```

휴먼이 응답하는 경로:
```
POST /v1/handraises/{id}/respond
Body: { "message": "이 경우 환불 승인" }
```

핸들러: `temporal.SignalWorkflow(ctx, handraiseWFID, "human_response", ...)`

## 도구 등록 (런타임)

```go
// 카탈로그에서 에이전트 로드 시
agent := agentkit.New(agentkit.Config{
    Tools: append(append(
        mcpRegistry.Tools(ctx),           // MCP 도구들
        catalog.DelegateTargets(ctx)...,  // 위임 가능한 에이전트들
    ), tools.Handraise(handraiseConfig)),  // handraise 1개
})
```

## 안전 / 보안

- 모든 tool args가 jsonschema 검증 통과
- 도구 실행은 **샌드박스 또는 격리 컨텍스트** (코드 실행은 E2B)
- delegate 시 cycle 검출 (A→B→A 차단)
- handraise는 휴먼 응답 검증 (관리자 권한 확인)
