# Nexora v2 — Rebuild Plan

> 기존 TS 19-package 코드는 폐기. 7개 컨셉만 가져가고 Go-first 멀티테넌트 에이전트 플랫폼으로 재구축.

## v0 정체성 한 줄

**Go-first, Temporal-durable, chi/REST+SSE 멀티테넌트 에이전트 플랫폼. Postgres가 source of truth, Python은 eval/최적화 작업에만 격리.**

## 트리

```
plan/
├── philosophy.md                  ← 가져갈 7개 컨셉
├── architecture/                  ← 시스템 아키텍처
├── stack/                         ← 기술 스택 결정
├── components/                    ← 컴포넌트 설계
├── data/                          ← 데이터 모델
├── roadmap/                       ← 12주 계획 + 마일스톤
├── operations/                    ← 운영 (관찰성/보안/배포)
└── adrs/                          ← Architecture Decision Records
```

## 빠른 진입점

| 알고 싶은 것 | 파일 |
|---|---|
| 무엇을 만드는가 / 왜 | [philosophy.md](philosophy.md) |
| 어떻게 굴러가는가 | [architecture/README.md](architecture/README.md) |
| 어떤 라이브러리/서비스 | [stack/README.md](stack/README.md) |
| 컴포넌트 설계 | [components/README.md](components/README.md) |
| DB 스키마 | [data/postgres-schema.md](data/postgres-schema.md) |
| 12주 일정 | [roadmap/12-week-plan.md](roadmap/12-week-plan.md) |
| Agent fleet OS 진화 계획 | [roadmap/agent-fleet-os-plan.md](roadmap/agent-fleet-os-plan.md) |
| 결정 근거 | [adrs/README.md](adrs/README.md) |

## 핵심 결정 (모두 ADR 있음)

1. **Go + Python eval 사이드카** — [ADR-001](adrs/adr-001-language-go.md)
2. **Temporal durable execution** — [ADR-002](adrs/adr-002-temporal-durable-execution.md)
3. **Postgres + pgvector** — [ADR-003](adrs/adr-003-postgres-pgvector.md)
4. **MCP 도구 표준** — [ADR-004](adrs/adr-004-mcp-tools.md)
5. **Langfuse 셀프호스트 + OTel** — [ADR-005](adrs/adr-005-langfuse-otel.md)
6. **Python eval 사이드카** — [ADR-006](adrs/adr-006-python-eval-sidecar.md)
7. **Mastra 미채택** — [ADR-007](adrs/adr-007-mastra-not-adopted.md)
8. **chi HTTP 프레임워크** — [ADR-008](adrs/adr-008-chi-http-framework.md)
9. **자작 agentkit** — [ADR-009](adrs/adr-009-self-built-agentkit.md)

## Top 3 리스크

1. `agentkit` scope creep — 얇은 facade로 유지
2. Temporal 오용 — deterministic 경계 / activity idempotency / 버저닝 규율
3. 멀티테넌트 데이터 격리 — 모든 쿼리·trace·log·cache key·tool call이 태생부터 tenant ID 보유

## v0 출시 전 must-fill 7개

1. `log/slog` 구조화 로깅 + request/tenant/run ID
2. 타입드 `apperr` → RFC 9457 problem JSON
3. Redis 백드 per-tenant rate limit
4. `/v1` URL prefix + 버전드 SSE 이벤트명
5. `/livez` `/readyz` `/healthz` probes
6. 클라우드 secret manager + envelope 암호화
7. stdlib testing + httptest + testify + **Testcontainers**
