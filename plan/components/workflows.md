# Temporal Workflows 인벤토리

플랫폼이 운영하는 모든 워크플로의 단일 출처.

## 워크플로 목록

| 워크플로 | 책임 | 지속시간 | 시그널 |
|---|---|---|---|
| `AgentSessionWorkflow` | 사용자-에이전트 대화 라이프사이클 (히스토리, 누적 비용, 페르소나) | 분~일 | `user_message`, `cancel`, `interrupt` |
| `AgentRunWorkflow` | 단일 ReAct 루프 (think→tool→observe) | 초~분 | `cancel` |
| `HandoffWorkflow` | 에이전트 A → 에이전트 B 위임. child workflow | 타깃에 의존 | (부모 따라감) |
| `SkillAuthoringWorkflow` | Skill 자기학습: draft→eval→approval→version pin→publish | 시간~일 (휴먼 대기) | `human_approve`, `human_reject` |
| `CatalogPromotionWorkflow` | Agent/Skill 카나리 롤아웃 (5% → 50% → 100%, 메트릭 게이트) | 시간~일 | `rollback`, `force_promote` |
| `EvalRunWorkflow` | Python 사이드카에 평가 위임. 테스트 케이스 병렬 실행 | 분 | `cancel` |
| `TenantOnboardingWorkflow` | 신규 테넌트: DB → 시크릿 → 기본 카탈로그 → 환영 메일 | 분 | (없음) |
| `BudgetCycleWorkflow` (cron) | 일/월 budget 카운터 롤오버, 사용량 리포트 | 분, 주기 | (없음) |
| `HandraiseWorkflow` | 에이전트 → 사람 escalate. 응답 대기 후 결과 주입 | 시간~일 | `human_response`, `timeout` |
| `TenantDeleteWorkflow` | 테넌트 삭제 (30일 grace + cleanup) | 30일+ | `cancel_delete` |
| `BYOKRotationWorkflow` | 테넌트 BYOK API key 로테이션 | 분 | (없음) |

## 워크플로 작성 규율

### Deterministic 원칙
워크플로 함수 안에서 **금지**:
- 직접 LLM/HTTP/DB 호출 → activity로 위임
- `time.Now()`, `rand.Intn()` → `workflow.Now()`, `workflow.SideEffect()`
- 외부 상태 의존 (글로벌 변수 등)
- 비결정적 map iteration (Go 1.x map은 순서 무작위)

### Activity 원칙
- Idempotent (재시도 안전)
- 작은 단위 (실패 시 재실행 비용 최소화)
- Timeout 명시 (ScheduleToClose, StartToClose)
- RetryPolicy 명시 (MaxAttempts, InitialInterval, BackoffCoefficient)

### 시그널 / 쿼리
- 시그널 = 외부 이벤트 (사용자 cancel, 휴먼 응답)
- 쿼리 = 워크플로 현재 상태 조회 (read-only)
- 시그널은 **deterministic 코드 안에서 처리**

### 버저닝
코드 바꿀 때 진행 중 워크플로 깨지면 안 됨:
```go
v := workflow.GetVersion(ctx, "add-new-step", workflow.DefaultVersion, 1)
if v == 1 {
    // 새 로직
} else {
    // 기존 로직 (진행 중 워크플로용)
}
```

## Task queue 분리

| Task queue | 워커 풀 | 우선순위 |
|---|---|---|
| `agent-runs` | 메인 — 대다수 워크로드 | 높음 |
| `eval-runs` | Python 사이드카 호출 전용 | 중 |
| `onboarding` | 신규 테넌트 | 중 |
| `catalog` | 카나리 롤아웃 | 낮음 |
| `cron` | 주기 작업 (budget cycle) | 낮음 |

큐별로 워커 수와 동시성 제한 별도 설정.

## 관찰성

- 모든 워크플로 / activity 자동 OTel span
- Temporal Web UI = 워크플로 inspector
- 실패한 워크플로 → Slack 알람 (특정 워크플로 유형만)
- 메트릭: `temporal.workflow.duration` (workflow type, status 라벨)

## 안전 / 격리

- 모든 워크플로 입력에 `tenant_id` 포함 강제 (input struct에 필수 필드)
- Activity 안에서 `tenant.WithID(ctx, input.TenantID)` 박은 후 호출
- 워크플로 → activity 호출 시 tenant 컨텍스트 자동 전파 (Temporal interceptor)

## 테스트

- 단위: `temporalio/sdk-go/testsuite` (시간 제어, 시그널 발사)
- 통합: Testcontainers + Temporal devserver
- 회귀: 워크플로 히스토리 replay로 결정론 깨짐 검출
