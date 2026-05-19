# 멀티테넌트 모델

## 원칙

**테넌트는 1급 primitive**. 모든 데이터·요청·로그·trace·캐시·도구 호출이 태생부터 `tenant_id`를 가짐.

## 격리 레벨 — Tier 3 (논리적 격리, 공유 인프라)

| Tier | 의미 | 우리 선택 이유 |
|---|---|---|
| Tier 1: 물리적 (DB/cluster 분리) | 가장 강함 | 비용·운영 부담 너무 큼 |
| Tier 2: 스키마 분리 (DB schema per tenant) | 강함 | 수천 테넌트 시 마이그레이션 지옥 |
| **Tier 3: 행 레벨 (tenant_id 컬럼)** | 표준 | **선택** — 검증된 패턴, 운영 단순 |
| Tier 4: 어플리케이션 레이어만 | 약함 | 격리 약함, 우리 요구 못 맞춤 |

엔터프라이즈 고객이 Tier 1/2를 요구하면 v2에서 dedicated 인스턴스 옵션 추가.

## 컨텍스트 전파

`context.Context`에 `TenantID` 박혀서 전 경로 흐름:

```go
// 미들웨어가 박음
ctx = tenant.WithID(ctx, tenantID)

// 모든 DB 쿼리가 받음
db.Query(ctx, "SELECT ... WHERE tenant_id = $1", tenant.IDFrom(ctx))

// 모든 LLM 호출이 받음
llm.Call(ctx, prompt)  // 내부에서 tenant.IDFrom(ctx)로 모델 라우팅·budget 체크

// 모든 로그가 받음
slog.InfoContext(ctx, "agent.run.started")  // tenant_id 자동 첨부

// 모든 trace span이 받음
span.SetAttributes(attribute.String("tenant.id", tenant.IDFrom(ctx)))
```

## 강제 게이트

각 게이트는 **tenant_id 없으면 panic 또는 에러**:

| 게이트 | 위치 | 강제 |
|---|---|---|
| HTTP 인증 미들웨어 | 모든 `/v1/*` 라우트 | WorkOS 토큰 → tenant_id 추출. 없으면 401 |
| DB 쿼리 래퍼 | `db/tenant.go` | `WithTenant(ctx)` 통과 안 한 쿼리는 lint 오류 |
| LLM activity | `activities/llm.go` | `tenant.IDFrom(ctx)` 없으면 panic |
| Tool activity | `activities/tool.go` | 동일 |
| Cache 키 | `cache/key.go` | 모든 키가 `tenant:{id}:...` prefix 강제 |
| Rate limit 키 | `ratelimit/key.go` | 동일 |
| Audit 로그 | `audit/write.go` | `tenant_id` 필수 컬럼, NOT NULL |

## 테넌트별 설정

각 테넌트가 가질 수 있는 설정:

| 설정 | 의미 | 저장 |
|---|---|---|
| `persona` | 에이전트 페르소나 텍스트 오버라이드 | Postgres `tenant_personas` |
| `tool_allowlist` | 허용 도구 목록 (catalog 도구의 subset) | Postgres `tenant_tool_grants` |
| `model_routing` | tenant별 모델 선택 (예: enterprise → Claude Opus, free → Haiku) | Postgres `tenant_model_routes` |
| `budget` | 일/월 토큰·$ 한도, 강제 모드 (block/warn/log) | Postgres `tenant_budgets` |
| `rate_limits` | RPS, 동시 세션 수 | Postgres `tenant_limits` |
| `skill_overrides` | tenant별 Skill 활성화/비활성화 | Postgres `tenant_skill_states` |
| `secrets` | tenant 자체 API 키 (BYOK) | envelope 암호화 + secret manager |

## 테넌트 라이프사이클

- **Onboarding**: `TenantOnboardingWorkflow`가 DB 레코드 → 시크릿 프로비저닝 → 기본 카탈로그 복제 → 환영 메일 발송
- **Suspend**: `tenants.status = 'suspended'` → 모든 미들웨어가 403 반환, 진행 중 워크플로는 계속 (cleanup)
- **Delete**: 30일 grace period → 완전 삭제 (audit 제외) → audit 로그는 법적 요구 기간 보존
- **Migration** (스키마 변경): Postgres 마이그레이션 + 데이터 변환 워크플로

## 테스트 강제

CI에서:
- `tenant_id` 컬럼 없는 새 테이블 = 빌드 실패 (린트 룰)
- `tenant.IDFrom(ctx)` 안 부르는 새 activity = 빌드 실패
- 캐시/rate 키가 `tenant:` prefix 없으면 빌드 실패

→ 멀티테넌트 정확성은 **코드 리뷰로 잡지 말고 컴파일/린트로 잡는다**.
