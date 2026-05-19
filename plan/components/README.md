# 컴포넌트

5~7 패키지 모노레포로 시작. 19 패키지 안 만든다.

## 패키지 맵

```
nexora/
├── cmd/
│   ├── api/              ← chi HTTP 서버 진입점
│   ├── worker/           ← Temporal 워커 진입점
│   └── nexorad/          ← cobra CLI (운영/dev 도구)
│
├── internal/
│   ├── tenant/           ← tenant context, policy, allowlist
│   ├── budget/           ← pre-execution budget gate
│   ├── catalog/          ← agent manifest registry
│   ├── skills/           ← Skills 자기학습 라이프사이클
│   ├── agentkit/         ← 에이전트 런타임 facade (★ 코어)
│   ├── tools/            ← MCP + delegate + handraise
│   ├── audit/            ← immutable audit ledger
│   ├── workflows/        ← Temporal workflow 정의들
│   ├── activities/       ← Temporal activity 정의들
│   ├── http/             ← chi 핸들러, 미들웨어
│   ├── db/               ← Postgres 추상, tenant-aware wrapper
│   ├── llm/              ← anthropic-sdk-go / openai-go 래퍼, fallback
│   ├── observability/    ← OTel + Langfuse 래퍼
│   ├── apperr/           ← 타입드 에러 + RFC 9457 problem JSON
│   ├── config/           ← koanf 로더
│   └── ratelimit/        ← Redis 백드 limiter
│
├── pkg/                  ← (외부 공개 API 있으면 여기)
│
└── python-eval/          ← Python eval 사이드카 (별도 Dockerfile)
```

## 컴포넌트별 설계 문서

| 컴포넌트 | 문서 |
|---|---|
| **agentkit** (★ 코어) | [agent-runtime.md](agent-runtime.md) |
| tenant policy | [tenant-policy.md](tenant-policy.md) |
| budget gate | [budget-gate.md](budget-gate.md) |
| Skills 라이프사이클 | [skills-lifecycle.md](skills-lifecycle.md) |
| tools (MCP/delegate/handraise) | [tools.md](tools.md) |
| catalog (agent manifest registry) | [catalog.md](catalog.md) |
| audit | [audit.md](audit.md) |
| Temporal workflows 인벤토리 | [workflows.md](workflows.md) |

## 의존 그래프 (간략)

```
http handlers
   │
   ▼
catalog (agent manifest 로드)
   │
   ▼
Temporal.ExecuteWorkflow
   │
   ▼
AgentRunWorkflow
   ├─→ tenant (정책)
   ├─→ budget (gate)
   ├─→ agentkit (런타임)
   │    ├─→ llm (provider 호출)
   │    └─→ tools (MCP/delegate/handraise)
   ├─→ skills (Skill resolve)
   ├─→ audit (write)
   └─→ observability (trace)
```

## 패키지 분리 원칙

1. **순환 의존 금지** — 위 그래프가 DAG
2. **내부 패키지는 `internal/`** — 외부 import 차단
3. **인터페이스는 사용자 측 패키지에 정의** — 구현체에 두지 않음 (Go 관례)
4. **테스트는 같은 디렉토리** — `*_test.go`
5. **컨텍스트 받지 않는 함수 의심** — context.Context는 거의 모든 함수 첫 인자
