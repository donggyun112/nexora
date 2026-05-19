# audit — immutable ledger

## 책임

내부 운영용 immutable 감사 로그. **append-only**. 모든 중요한 이벤트 기록.

## 다른 로그와 분리

| 도메인 | 저장 | 용도 |
|---|---|---|
| **Audit** | Postgres `audit_*` 테이블 (append-only) | 내부 운영, 법적 요구, 디버깅 |
| Customer-facing audit | WorkOS Audit Logs | 고객이 자기 활동 조회 |
| LLM trace | Langfuse | 프롬프트·응답·비용 분석 |
| 일반 로그 | `log/slog` JSON → Loki | 디버깅 |

이 4개 섞지 마. 각자 다른 보존 기간·접근 권한·query 패턴.

## 기록 대상

| 이벤트 | 테이블 |
|---|---|
| Agent run 시작/종료 | `audit_runs` |
| 모든 turn (LLM 호출 결과) | `audit_turns` |
| 모든 tool 호출 | `audit_tool_calls` |
| Budget 결정 (block/warn) | `audit_budget_decisions` |
| Skill 라이프사이클 변경 | `audit_skill_events` |
| 카탈로그 변경 (promote/rollback) | `audit_catalog_events` |
| 테넌트 변경 (suspend/delete) | `audit_tenant_events` |
| 인증 이벤트 (login/SSO) | `audit_auth_events` |

## 스키마 패턴

```sql
CREATE TABLE audit_runs (
    id           UUID PRIMARY KEY,
    tenant_id    TEXT NOT NULL,
    agent_id     TEXT NOT NULL,
    agent_version TEXT NOT NULL,
    started_at   TIMESTAMPTZ NOT NULL,
    ended_at     TIMESTAMPTZ,
    status       TEXT NOT NULL,        -- running/completed/failed/blocked/cancelled
    final_reason TEXT,                  -- e.g., budget_exceeded, max_turns
    total_tokens INT,
    total_cost_cents BIGINT,
    user_id      TEXT,                  -- WorkOS user
    request_id   TEXT NOT NULL,         -- HTTP request 추적
    metadata     JSONB
);

CREATE INDEX audit_runs_tenant_time ON audit_runs (tenant_id, started_at DESC);
CREATE INDEX audit_runs_status ON audit_runs (status) WHERE status != 'completed';

-- append-only 강제: UPDATE/DELETE는 별도 권한 필요
REVOKE UPDATE, DELETE ON audit_runs FROM nexora_app;
```

## append-only 강제

- DB 사용자 권한으로 UPDATE/DELETE 차단
- 수정 필요 시 별도 admin 계정 + 워크플로
- 보존 기간 정책 (예: 7년) 별도 cron으로 cold storage 이동

## 작성 API

```go
package audit

type Writer interface {
    StartRun(ctx context.Context, info RunStart) (RunID, error)
    EndRun(ctx context.Context, id RunID, info RunEnd) error
    RecordTurn(ctx context.Context, runID RunID, turn TurnInfo) error
    RecordToolCall(ctx context.Context, runID RunID, call ToolCallInfo) error
    RecordBudgetDecision(ctx context.Context, decision BudgetDecisionInfo) error
}

// tenant_id 없으면 panic — 컴파일 타임에 잡지 못하면 런타임 panic
```

## 호출 지점

audit은 **activity 안에서** 호출 — 워크플로 안에서 호출하면 deterministic 위반.

```go
// activity 함수 예
func RecordTurnActivity(ctx context.Context, in RecordTurnInput) error {
    return auditWriter.RecordTurn(ctx, in.RunID, in.Turn)
}
```

워크플로:
```go
workflow.ExecuteActivity(ctx, activities.RecordTurn, RecordTurnInput{...})
```

## 쿼리 API

```
GET /v1/audit/runs?tenant_id=X&from=...&to=...&limit=100
GET /v1/audit/runs/{id}/turns
GET /v1/audit/runs/{id}/tool-calls
```

페이지네이션 cursor 기반. 큰 결과는 R2로 export 후 presigned URL.

## 비식별화

audit에 PII 들어가지 않게:
- input/output 자체는 audit에 저장 안 함 (Langfuse가 가짐, redaction 가능)
- audit는 메타데이터만 (run_id, agent_id, turn 번호, 토큰 수, 비용 등)
- 사용자 메시지 자체가 필요한 경우는 redaction 후 별도 plan_messages 테이블

## 데이터 거버넌스

- 보존: 7년 (조정 가능, tenant plan별)
- 익명화: 테넌트 삭제 시 audit는 보존하되 PII 마스킹
- 접근: WorkOS RBAC → audit:read 권한 필요
- 익스포트: 테넌트가 자기 audit 다운로드 가능 (GDPR/CCPA 대응)
