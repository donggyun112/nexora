# tenant policy

## 책임

- 요청에서 `tenant_id` 안전하게 추출 (WorkOS 토큰 → tenant)
- 모든 호출 경로에서 `tenant.IDFrom(ctx)` 자동 propagation
- 테넌트별 정책 (도구 allowlist, 모델 routing, 한도) 적용
- 미들웨어/lint로 누락 자동 차단

## 핵심 타입

```go
package tenant

type ID string

// 컨텍스트에 박기 / 빼기
func WithID(ctx context.Context, id ID) context.Context
func IDFrom(ctx context.Context) ID  // 없으면 panic (코드 버그) — 미들웨어가 항상 박음

// 테넌트 메타데이터 (DB에서 로드, 캐시)
type Tenant struct {
    ID           ID
    Name         string
    Status       Status         // active / suspended / deleting
    Plan         PlanID
    Persona      string          // 에이전트 페르소나 오버라이드
    ToolGrants   []ToolGrant
    ModelRoutes  []ModelRoute
    Budget       BudgetConfig
    Limits       Limits
    SkillStates  map[SkillID]SkillState
    BYOKSecrets  map[ProviderID]EncRef
}

type Store interface {
    Get(ctx context.Context, id ID) (Tenant, error)
    List(ctx context.Context, filter Filter) ([]Tenant, error)
    Update(ctx context.Context, t Tenant) error
    // 캐시는 내부에 — Redis로 hot path
}
```

## 미들웨어

```go
// chi 미들웨어, 모든 /v1/* 라우트에 적용
func ResolveMiddleware(workos *workos.Client, store Store) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            session := workos.Session(r)
            tenantID := tenant.ID(session.OrganizationID)
            
            t, err := store.Get(r.Context(), tenantID)
            if err != nil || t.Status != Active {
                apperr.WriteProblem(w, apperr.TenantNotActive(tenantID))
                return
            }
            
            ctx := tenant.WithID(r.Context(), tenantID)
            ctx = tenant.WithMeta(ctx, t)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}
```

## 정책 적용 지점

| 지점 | 정책 |
|---|---|
| 에이전트 카탈로그 lookup | tenant가 해당 agent에 접근 권한 있나? |
| 도구 결정 | tenant tool_allowlist의 교집합만 |
| 모델 선택 | tenant.ModelRoutes에서 매핑 |
| LLM API key | tenant BYOK 있으면 그것 사용, 없으면 플랫폼 키 |
| Skill resolve | tenant.SkillStates에서 활성 버전 선택 |
| 캐시 키 | `tenant:{id}:...` prefix 필수 |
| 로그 / trace | `tenant_id` 라벨 자동 첨부 |

## Lint 규칙 (CI에서 강제)

- `tenant_id` 컬럼 없는 새 테이블 마이그레이션 = 빌드 실패
- `tenant.IDFrom(ctx)` 또는 `tenant.MetaFrom(ctx)` 호출 안 하는 activity = 빌드 실패
- 캐시 키가 `tenant:` prefix 없는 경우 = 빌드 실패
- 직접 SQL에서 `tenant_id` 비교 빠지면 = 빌드 실패

→ `internal/lint/` 패키지에 정적 분석 룰 작성. CI에서 `golangci-lint` 커스텀 plugin으로 실행.

## 테스트

- 단위 테스트: tenant ID 없는 컨텍스트로 호출 시 panic 확인
- 통합 테스트: 두 테넌트 동시 호출 시 데이터 누설 없음 (Testcontainers)
- 퍼지 테스트: 잘못된 토큰 → 403, 만료 토큰 → 401, 다른 테넌트의 자원 접근 → 404
