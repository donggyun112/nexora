# 관찰성

## 세 신호 분리

| 신호 | 도구 | 보존 |
|---|---|---|
| **분산 trace + metric + log** | OTel → Tempo (또는 Honeycomb) | 7일 |
| **LLM trace (프롬프트·응답·비용)** | Langfuse 셀프호스트 | 90일 |
| **구조화 로그** | slog JSON → Loki (또는 Cloud Logging) | 30일 |
| **immutable audit ledger** | Postgres `audit_*` | 7년 |
| **에러 추적** | Sentry (옵션) | 90일 |

각자 다른 목적·접근권한·query 패턴. 섞지 마.

## OTel 설정

```go
// 부트스트랩
import "go.opentelemetry.io/otel"

tp, _ := traceProviderFor(cfg.OTel)  // Collector endpoint
otel.SetTracerProvider(tp)
otel.SetTextMapPropagator(propagation.TraceContext{})
```

미들웨어:
```go
r.Use(otelchi.Middleware("nexora-api"))
```

워크플로 / activity 자동 trace:
```go
import "go.temporal.io/sdk/contrib/opentelemetry"
worker.New(..., worker.Options{
    Interceptors: []interceptor.WorkerInterceptor{
        opentelemetry.NewTracingInterceptor(opentelemetry.TracerOptions{}),
    },
})
```

## 표준 span 라벨

모든 span에 자동:
- `tenant.id`
- `request.id`
- `run.id` (워크플로 안)
- `agent.id`
- `agent.version`

LLM span에 추가:
- `llm.provider` (anthropic/openai)
- `llm.model`
- `llm.tokens.input`
- `llm.tokens.output`
- `llm.cost.cents`

Tool span에 추가:
- `tool.name`
- `tool.kind` (mcp/delegate/handraise)
- `tool.duration_ms`

## Langfuse 통합

```go
// 자작 래퍼 (Go SDK 없음)
type LangfuseClient struct { httpClient *http.Client; apiKey string }

func (c *LangfuseClient) RecordGeneration(ctx context.Context, gen Generation) error {
    // POST to /api/public/generations
}

func (c *LangfuseClient) RecordScore(ctx context.Context, score Score) error {
    // POST to /api/public/scores
}
```

매 LLM activity 안에서 자동 호출 — OTel span과 함께.

## slog 표준

```go
slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
    Level: cfg.LogLevel,
    AddSource: false,
})))

// 미들웨어가 ctx에 attr 박음
ctx = slog.NewContextLogger(ctx, "request_id", reqID)
ctx = slog.NewContextLogger(ctx, "tenant_id", tenantID)

// 사용
slog.InfoContext(ctx, "agent.run.started", "agent_id", agentID)
```

JSON 출력:
```json
{
  "time": "2026-05-13T10:00:00Z",
  "level": "INFO",
  "msg": "agent.run.started",
  "request_id": "req_abc",
  "tenant_id": "t_xyz",
  "agent_id": "support-tier1"
}
```

## 알람

| 신호 | 임계 | 대상 |
|---|---|---|
| 에러율 > 1% (5분 window) | 즉시 | Slack #alerts |
| LLM provider 5xx 지속 | 1분 | Slack #ops |
| Budget 한도 80% 도달 | 즉시 | 테넌트 + 관리자 |
| Workflow 실패 (특정 워크플로) | 즉시 | Slack #ops |
| DB 연결 풀 > 80% | 5분 | PagerDuty |
| Temporal task queue depth > 1000 | 5분 | Slack #ops |

라우팅: Grafana Alerting 또는 Datadog → Slack/PagerDuty.

## 대시보드 (Grafana)

v0 최소 4개:
1. **System health**: API 응답 시간, 에러율, RPS
2. **Per-tenant**: 테넌트 N개 활동량, 비용, 에러
3. **LLM**: provider별 호출 수·실패율·평균 응답시간·비용
4. **Workflow**: 워크플로 유형별 처리량·지속시간·실패율

## 디버깅 가이드 (runbook 본체)

각 인시던트 카테고리별:
- **LLM provider 다운**: 자동 fallback 작동 확인, 수동 fallback 강제 토글
- **DB 다운**: 읽기 전용 모드 전환, 캐시 fallback
- **Temporal 다운**: 신규 워크플로 차단, 진행 중 보존, 복구 후 재개
- **테넌트 abuse**: rate limit 일시 강화, suspend 결정
- **runaway loop**: 워크플로 강제 종료, budget 즉시 차단
