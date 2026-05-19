# Skills 자기학습 라이프사이클

Nexora의 핵심 wedge 중 하나. Anthropic Skills 스키마를 베이스로 **자기학습 메커니즘**을 얹음.

## 라이프사이클

```
[1] 트리거: 에이전트가 패턴 발견
    "사용자가 자주 묻는 환불 정책 — Skill로 만들면 매번 검색 안 해도 됨"
       │
       ▼
[2] 자동 생성 (drafted)
    SkillAuthoringWorkflow 시작
       │ ├── LLM에게 SKILL.md 초안 작성 요청
       │ ├── provenance 기록 (어떤 turn에서 발견했나, 어떤 데이터 기반)
       │ └── status='drafted', version=0
       ▼
[3] 자동 평가 (evaluated)
    Python eval 사이드카가 골든 셋에 대해 점수 계산
       │ ├── 정확도 / 재현율 / 비용 절감 추정
       │ └── status='evaluated', eval_results=...
       ▼
[4] 휴먼 승인 대기 (pending_review)
    SkillAuthoringWorkflow가 시그널 대기
       │ ├── 알림 → 관리자 콘솔 / Slack
       │ ├── 관리자: approve / reject / request_changes
       │ └── 시그널 받으면 진행
       ▼
[5] 버전 핀 (versioned)
    semver 부여, immutable
       │ ├── 1.0.0
       │ ├── S3 R2에 SKILL.md 영구 저장
       │ └── status='versioned'
       ▼
[6] 테넌트 활성화 (active)
    tenant별로 활성/비활성 (옵트인)
       │ ├── 기본: 비활성 (관리자가 명시적 활성화)
       │ ├── tenant_skill_states 테이블에 매핑
       │ └── 카나리 가능: 10% → 50% → 100%
       ▼
[7] 롤백 가능
    포인터 스왑 — 이전 버전으로 즉시 전환
       │ ├── tenant_skill_states.active_version = 'X.Y.Z'
       │ └── 새 호출부터 적용 (in-flight는 그대로)
```

## 데이터 모델

```sql
-- Skill 정의 (immutable per version)
CREATE TABLE skills (
    id            TEXT NOT NULL,           -- skill slug
    version       TEXT NOT NULL,           -- semver
    status        TEXT NOT NULL,           -- drafted/evaluated/pending_review/versioned/deprecated
    content_uri   TEXT NOT NULL,           -- R2 URI to SKILL.md
    schema        JSONB NOT NULL,          -- Anthropic Skills 스키마
    provenance    JSONB NOT NULL,          -- {agent_id, run_id, turn, source_data}
    eval_results  JSONB,                   -- 평가 점수
    approved_by   TEXT,                    -- WorkOS user id
    approved_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (id, version)
);

-- 테넌트별 활성 상태
CREATE TABLE tenant_skill_states (
    tenant_id      TEXT NOT NULL,
    skill_id       TEXT NOT NULL,
    active_version TEXT,                   -- NULL = 비활성
    rollout_pct    INT DEFAULT 100,        -- 카나리용
    enabled_at     TIMESTAMPTZ,
    PRIMARY KEY (tenant_id, skill_id)
);
```

## SKILL.md 포맷 (Anthropic Skills 스키마)

```markdown
---
name: refund_policy_v1
description: 환불 정책 30일 이내 요청 처리
when_to_use:
  - 사용자가 환불 요청
  - 구매 후 30일 이내
inputs:
  - order_id: string
outputs:
  - decision: approved | denied | escalate
provenance:
  agent_id: support-tier1
  source_runs: [run_abc, run_xyz]
  created_by: skill-authoring-workflow
---

# 환불 정책 처리

## 단계
1. order_id로 주문 조회
2. 결제일 30일 이내 확인
3. 30일 초과 시 → escalate
4. 30일 이내 + 미사용 → approved
5. 30일 이내 + 사용 흔적 → manager 검토 요청
...
```

## 자동 생성 트리거

에이전트가 `propose_skill` 도구를 호출 (built-in):
```go
agentkit.ToolFn("propose_skill", "반복 패턴을 Skill로 추출 제안",
    func(ctx context.Context, args ProposeSkillArgs) (ProposeSkillResult, error) {
        // SkillAuthoringWorkflow 트리거
        return triggerWorkflow(ctx, args), nil
    })
```

워크플로:
```
SkillAuthoringWorkflow
├── activity: GenerateDraft (LLM 호출, SKILL.md 작성)
├── activity: RunEval (Python 사이드카 호출)
├── 시그널 대기: human_review (timeout 7일)
│   ├── approve → PinVersion activity
│   ├── reject → 종료
│   └── request_changes → 1단계로
├── activity: PinVersion (S3에 저장, DB 레코드)
└── activity: NotifyApproved
```

## Resolve 로직 (런타임)

에이전트 실행 시 Skill 해상:

```go
func ResolveInstructions(ctx context.Context, agent AgentManifest) string {
    base := agent.BaseInstructions
    
    // 활성 Skill 목록 (테넌트별)
    activeSkills := skillStore.ActiveForTenant(ctx, tenant.IDFrom(ctx), agent.ID)
    
    // SKILL.md 내용 concat
    for _, skill := range activeSkills {
        base += "\n\n" + skill.Content
    }
    
    return base
}
```

## 회귀 방지

`CatalogPromotionWorkflow`가 새 Skill 버전 활성화 전:
1. 골든 셋 + 회귀 셋 모두 실행 (Python 사이드카)
2. baseline 대비 점수 비교
3. 정확도 또는 비용에서 5% 이상 악화 → 자동 롤백
4. 통과 시 점진 활성화 (10% → 50% → 100%)

## 보안 / 안전

- LLM이 생성한 SKILL.md는 **execution 없음** — 그냥 텍스트 인스트럭션
- 도구 호출 권한은 별도 — Skill이 새 도구를 자기 권한으로 끌어올 수 없음
- 휴먼 승인 필수 (auto-approve 모드는 v1+에서 신중히)
- 모든 변경은 감사 로그 기록
