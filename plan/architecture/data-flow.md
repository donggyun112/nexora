# 데이터 흐름 — 에이전트 1회 실행

가장 빈번한 흐름. 이게 깔끔하면 나머지는 변형.

## 1) 사용자 요청 도착

```
POST /v1/agents/run
Headers:
  Authorization: Bearer <workos-token>
  X-Tenant-ID: tenant_abc  (선택, 토큰에서 추론 가능)
Body:
  { "agent_id": "support-tier1", "message": "I want a refund" }

Accept: text/event-stream  (SSE 응답)
```

## 2) 미들웨어 체인 통과

```
Cloudflare (DDoS, 거친 rate)
   ↓
chi:
   1. recoverer (panic → 500)
   2. requestID (req_xxx 생성)
   3. workos.AuthMiddleware (토큰 검증)
   4. tenant.ResolveMiddleware (토큰 → tenant_id → ctx에 박음)
   5. ratelimit.PerTenantMiddleware (Redis 백드, tenant별 RPS)
   6. otel.SpanMiddleware (span 시작, tenant.id 라벨)
   7. audit.StartMiddleware (audit_id 생성, ctx에 박음)
   8. slog 미들웨어 (request_id + tenant_id 자동 첨부)
```

## 3) chi 핸들러

```go
func (h *AgentsHandler) Run(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    var input AgentRunInput
    if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
        apperr.WriteProblem(w, apperr.InvalidJSON(err)); return
    }
    
    // 에이전트 manifest 로드 (테넌트 오버라이드 적용)
    agent, err := h.catalog.Resolve(ctx, input.AgentID)
    if err != nil { apperr.WriteProblem(w, err); return }
    
    // Temporal 워크플로 시작 (영속 ID 즉시 리턴)
    handle, err := h.temporal.ExecuteWorkflow(ctx,
        client.StartWorkflowOptions{
            ID:        fmt.Sprintf("run-%s", uuid.NewString()),
            TaskQueue: "agent-runs",
        },
        workflows.AgentRunWorkflow,
        workflows.AgentRunInput{
            TenantID: tenant.IDFrom(ctx),
            AgentID:  input.AgentID,
            Message:  input.Message,
            MaxTurns: agent.MaxTurns,
        },
    )
    if err != nil { apperr.WriteProblem(w, err); return }
    
    // SSE 스트림 시작 — Temporal에서 시그널/쿼리로 이벤트 받음
    h.streamRun(ctx, w, handle)
}
```

## 4) SSE 스트리밍

```
event: run.started
data: {"run_id": "run_abc"}

event: turn.started
data: {"turn": 0}

event: llm.token
data: {"text": "Let me check"}

event: tool.called
data: {"name": "searchKB", "args": {...}}

event: tool.result
data: {"name": "searchKB", "result": {...}}

event: turn.completed
data: {"turn": 0, "tokens_used": 1234, "cost_cents": 12}

event: budget.warning
data: {"tenant_id": "...", "remaining_cents": 200}

event: turn.started
data: {"turn": 1}

...

event: run.completed
data: {"final_message": "...", "total_tokens": 5678, "total_cost_cents": 56}
```

## 5) 워크플로 실행 (Temporal worker 프로세스에서)

```
AgentRunWorkflow 시작
   │
   ▼
[Turn 0]
   ├── activity: CheckBudget(tenant, agent)
   │     → Redis 체크 + Postgres 확인 → OK / blocked / warning
   │
   ├── activity: CallLLM(history)
   │     → anthropic-sdk-go 또는 openai-go
   │     → 응답 = message + (선택) tool_calls
   │     → Langfuse에 trace span 발행
   │     → 비용 → tenant budget 감산 (트랜잭션)
   │
   ├── (tool_calls 있으면) activity들 병렬:
   │     ├── CallTool(tool_0)  → MCP / delegate / handraise / E2B
   │     ├── CallTool(tool_1)
   │     └── ...
   │
   ├── activity: WriteAudit(turn_details)
   │     → Postgres immutable append
   │
   └── 시그널 받음: 사용자 cancel? → ctx 취소 전파
[Turn 1]
   ...
[Turn N 또는 final_message 도달]
   │
   ▼
워크플로 종료 → 최종 결과 SSE로 전송
```

## 6) 부수 효과 (워크플로 종료 후 또는 병렬)

- **Audit**: 모든 turn detail이 Postgres `audit_runs`에 영구 저장
- **Langfuse**: 전체 run trace + token cost + prompt version
- **Skills lifecycle**: 에이전트가 새 Skill 자동 생성을 요청했으면 `SkillAuthoringWorkflow` 트리거
- **Metrics**: tenant별 RPS, 토큰 사용량, 에러율 OTel metrics로

## 시그널 / 인터럽트

```
POST /v1/runs/{run_id}/interrupt
Body: { "reason": "user_cancelled" }
```

핸들러:
```go
h.temporal.SignalWorkflow(ctx, runID, "", "interrupt", InterruptSignal{Reason: ...})
```

워크플로 내부:
```go
selector.AddReceive(workflow.GetSignalChannel(ctx, "interrupt"), func(c workflow.ReceiveChannel, _ bool) {
    var sig InterruptSignal
    c.Receive(ctx, &sig)
    // 정리 활동 실행
})
```

## 실패 시나리오

| 실패 | 처리 |
|---|---|
| LLM provider 429 | Temporal activity retry policy 자동 (exponential backoff) |
| LLM provider down | smart fallback activity가 대체 provider로 전환 |
| Tool 호출 실패 | activity retry → max 후 LLM에 에러 메시지로 주입 |
| Worker 프로세스 크래시 | Temporal이 다른 워커로 재할당, 마지막 activity 후 상태에서 재개 |
| Budget 한도 도달 | `CheckBudget` activity가 에러 반환 → 워크플로 종료 + SSE에 `budget.exceeded` 이벤트 |
| 사용자 disconnect (SSE) | 워크플로는 계속 진행, 결과는 `/v1/runs/{id}` GET으로 확인 가능 |
