# catalog — agent manifest registry

에이전트는 **데이터로 관리**. 코드에 하드코딩 안 함.

## 책임

- agent manifest의 CRUD + 버전 관리
- 라우터 (요청 → 어떤 에이전트가 처리?)
- 카나리 / 롤아웃 / 롤백
- 테넌트 권한 매핑 (어떤 테넌트가 어떤 에이전트 쓸 수 있나)

## agent manifest

```yaml
id: support-tier1
version: 2.1.0
description: 1차 고객 지원 에이전트
architecture: react        # react | plan_execute | loop | deep_research
model:
  primary: claude-opus-4-7
  fallback: gpt-5.2
max_turns: 12
base_instructions: |
  너는 친절한 1차 고객 지원이다. ...
tools:
  - mcp:kb_search
  - mcp:order_lookup
  - delegate:billing-tier1
  - handraise:default
skills:
  - refund_policy_v1
  - shipping_inquiry_v2
guardrails:
  input:
    - pii_redactor
  output:
    - pii_redactor
    - profanity_filter
budget:
  default_window: daily
  default_limit_cents: 1000
metadata:
  owner: support-team
  created_at: 2026-01-15
```

## 데이터 모델

```sql
CREATE TABLE agents (
    id          TEXT NOT NULL,
    version     TEXT NOT NULL,           -- semver
    manifest    JSONB NOT NULL,
    status      TEXT NOT NULL,           -- 'draft' / 'published' / 'deprecated'
    created_at  TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (id, version)
);

CREATE TABLE tenant_agent_grants (
    tenant_id   TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    version     TEXT NOT NULL,           -- 현재 활성 버전
    rollout_pct INT DEFAULT 100,
    enabled_at  TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (tenant_id, agent_id)
);
```

## API

```
GET    /v1/agents                       # 카탈로그 list (테넌트 권한 필터)
GET    /v1/agents/{id}                  # 활성 버전 manifest
GET    /v1/agents/{id}/versions         # 모든 버전
POST   /v1/agents                       # 새 manifest 등록 (관리자)
PUT    /v1/agents/{id}/promote          # canary → production
POST   /v1/agents/{id}/rollback         # 이전 버전으로
DELETE /v1/agents/{id}/grants/{tenant}  # 테넌트 권한 회수
```

## 라우터 (요청 → 에이전트 매핑)

3가지 모드:

### 1) 명시적 (가장 흔함)
```
POST /v1/agents/run
{ "agent_id": "support-tier1", "message": "..." }
```
→ 카탈로그에서 직접 lookup

### 2) 벡터 라우터 (자동 매핑)
```
POST /v1/route
{ "message": "환불하고 싶어" }
```
→ embedding 비교 + LLM classifier로 best agent 선택

```go
func Route(ctx context.Context, msg string) (AgentID, error) {
    // 1) 후보 사전 필터 (벡터)
    candidates := vectorStore.Top(ctx, embed(msg), 5)
    
    // 2) LLM classifier (저렴한 모델)
    chosen := llm.Classify(ctx, msg, candidates)
    
    return chosen.ID, nil
}
```

### 3) 룰 기반 (조건 매칭)
```yaml
routing_rules:
  - if: "contains(message, '환불')"
    agent: support-tier1
  - if: "tenant.plan == 'enterprise' && contains(message, 'billing')"
    agent: billing-enterprise
```

테넌트가 자체 룰 정의 가능 (BYORouting).

## 버전 롤아웃 (카나리)

`CatalogPromotionWorkflow`:
```
[v2.1.0 published]
   ↓ 5% 트래픽으로
[5% canary, 1시간 관찰]
   ├─ 에러율 > baseline +10% → 자동 롤백
   └─ OK
   ↓
[50% canary, 6시간 관찰]
   ├─ 비용 > baseline +20% → 자동 롤백
   └─ OK
   ↓
[100% production]
```

각 단계에서:
- 에러율 / 비용 / 응답 시간 / 사용자 feedback 메트릭 비교
- 기준 위반 시 즉시 롤백 (`tenant_agent_grants.version` 이전 값으로)

## resolve 로직 (런타임 lookup)

```go
func Resolve(ctx context.Context, agentID string) (AgentManifest, error) {
    tenantID := tenant.IDFrom(ctx)
    
    grant, err := store.Grant(ctx, tenantID, agentID)
    if err != nil { return AgentManifest{}, apperr.AgentNotGranted(agentID) }
    
    // 카나리 — 랜덤 N%만 새 버전
    version := grant.Version
    if grant.RolloutPct < 100 && rand.Intn(100) >= grant.RolloutPct {
        version = grant.PreviousVersion
    }
    
    manifest, _ := store.Manifest(ctx, agentID, version)
    return manifest, nil
}
```

## 테스트 / Eval

새 manifest 등록 시:
1. 자동 schema 검증 (jsonschema)
2. 도구·Skill 참조 유효성 확인
3. 옵션: golden set eval 자동 실행 (Python 사이드카)
4. 결과를 manifest에 첨부

## 마켓플레이스 안 함 (v0)

- 자체 카탈로그만 (테넌트가 자기 에이전트 정의 가능, but 공유 마켓플레이스 X)
- 마켓플레이스 = scope creep. v2+에서 검토
