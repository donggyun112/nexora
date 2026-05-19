# 아키텍처

## 시스템 다이어그램

```
[Client]
   │
   ▼
[Cloudflare]                ← DDoS, WAF, edge rate limit, geo
   │
   ▼
┌────────────────────────────────────────────────────────────────┐
│ Go 서비스 (chi 라우터)                                          │
│                                                                │
│   HTTP API (REST + SSE)                                        │
│      ├── /v1/agents/run         POST + SSE 스트림              │
│      ├── /v1/sessions/{id}      GET/POST                       │
│      ├── /v1/skills             CRUD                           │
│      ├── /v1/tools              CRUD                           │
│      ├── /v1/tenants            admin                          │
│      ├── /v1/budgets            admin                          │
│      └── /livez /readyz /healthz                               │
│                                                                │
│   미들웨어 체인:                                                │
│      WorkOS auth → tenant resolve → rate limit                 │
│      → audit start → OTel span → 비즈니스 핸들러                │
│                                                                │
│   핸들러:                                                       │
│      Temporal.ExecuteWorkflow() 호출 → workflow ID 리턴         │
│                                                                │
└────────────────────────────────────────────────────────────────┘
   │
   ▼ (Temporal SDK)
┌────────────────────────────────────────────────────────────────┐
│ Temporal Server                                                │
│   - 워크플로 상태 영속 (자체 DB)                                │
│   - activity 스케줄링                                          │
│   - 재시도 / 시그널 / 자식 워크플로                             │
└────────────────────────────────────────────────────────────────┘
   │
   ▼ (워커 폴링)
┌────────────────────────────────────────────────────────────────┐
│ Go Worker 프로세스                                              │
│                                                                │
│   Workflows:                                                   │
│      AgentRunWorkflow, AgentSessionWorkflow,                   │
│      SkillAuthoringWorkflow, HandoffWorkflow,                  │
│      CatalogPromotionWorkflow, BudgetCycleWorkflow ...         │
│                                                                │
│   Activities (실제 부작용):                                     │
│      ├── CallLLM (anthropic-sdk-go / openai-go)                │
│      ├── CallTool (MCP / delegate / handraise)                 │
│      ├── CheckBudget (Postgres + Redis)                        │
│      ├── WriteAudit (Postgres immutable)                       │
│      ├── ResolveSkill (Postgres + S3)                          │
│      ├── InvokeSandbox (E2B HTTP)                              │
│      └── CallPythonEval (Python sidecar)                       │
└────────────────────────────────────────────────────────────────┘
   │            │              │              │
   ▼            ▼              ▼              ▼
[Postgres]   [Redis]      [Langfuse]    [Python eval 사이드카]
 + pgvector  rate/cache    OTel sink     DSPy/Pydantic AI
```

## 주요 흐름

| 흐름 | 파일 |
|---|---|
| 에이전트 1회 실행 (REST + SSE) | [data-flow.md](data-flow.md) |
| 테넌트 격리 모델 | [tenant-model.md](tenant-model.md) |

## 책임 분리

| 컴포넌트 | 책임 | 안 함 |
|---|---|---|
| **Cloudflare** | 엣지 보호, 거친 abuse 차단 | 비즈니스 로직, tenant 알지 못함 |
| **chi 핸들러** | 인증, tenant resolve, 요청 검증, 워크플로 시작 | LLM/도구 직접 호출, 긴 로직 |
| **Workflow** | 스텝 순서, 상태, 재시도, 시그널 | 부작용 직접 (LLM/DB/HTTP), deterministic 위반 금지 |
| **Activity** | 실제 부작용 (LLM, DB, 도구, 외부 API) | 다른 activity 직접 호출, 오케스트레이션 |
| **Python 사이드카** | DSPy/Pydantic AI eval, 프롬프트 최적화 | 컨트롤 플레인 로직, 요청 경로에 위치 |

## 단일 source of truth

| 데이터 종류 | 저장소 |
|---|---|
| 테넌트 / 카탈로그 / Skills / 감사 / 컨버세이션 히스토리 | **Postgres** |
| 임베딩 / 벡터 검색 | **pgvector** (Postgres 안) |
| 워크플로 실행 상태 | **Temporal DB** (자체) |
| 캐시 / rate counter / ephemeral coord | **Redis** |
| LLM trace / prompt version / eval 결과 | **Langfuse** |
| Skill 아티팩트 / 큰 blob | **Cloudflare R2** |

원칙: **한 종류의 데이터는 한 저장소에만**. 동기화 코드 짤 일 만들지 않음.
