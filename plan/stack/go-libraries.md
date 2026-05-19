# Go 라이브러리 감사 (2026.5)

블로커 없음 — Go 진행 OK. 직접 짤 코드 약 3주 + 작은 우회 셋.

## Tier 1 — Deal-breaker (모두 ✓ 또는 △)

| 라이브러리 | 상태 | 메모 |
|---|---|---|
| `temporalio/sdk-go` | ✓ 공식·성숙 | Workflow Streams / Standalone Activities / External Storage public preview. **OpenAI Agents SDK 통합은 Python만** — Temporal workflow로 직접 짬 |
| `anthropics/anthropic-sdk-go` | ✓ 공식·성숙 | Claude 4.7, prompt caching, tool use, streaming, vision. **Claude Agent SDK 자체는 Py/TS만** |
| `openai/openai-go` | ✓ 공식·성숙 | Responses API, 도구, 스트리밍, 구조화 출력. **OpenAI Agents SDK Go 공식판 없음** (커뮤니티 포팅 nlpodyssey/openai-agents-go 있지만 비공식) |
| `modelcontextprotocol/go-sdk` | ✓ 공식 (2025) | Google과 공동 유지. TS/Python SDK와 패리티 |
| `go.opentelemetry.io/otel` | ✓ 공식·성숙 | 무이슈 |
| `jackc/pgx/v5` + `pgvector/pgvector-go` | ✓ 공식·성숙 | de facto |
| **Langfuse Go SDK** | △ **없음** | OTel export + REST 래퍼로 우회. 약 300 LOC 자작 |

## Tier 2 — 모두 ✓

| 라이브러리 | 상태 | 비고 |
|---|---|---|
| `go-chi/chi` | ✓ | HTTP 라우터, net/http 네이티브 |
| `redis/go-redis/v9` | ✓ | |
| `go-playground/validator` | ✓ | 구조체 검증 |
| `pressly/goose/v3` | ✓ | DB 마이그레이션, SQL+Go funcs 하이브리드 |
| `spf13/cobra` | ✓ | CLI |
| `workos/workos-go` v7 | ✓ | SSO/SCIM/Org/Audit |
| `knadh/koanf/v2` | ✓ | 설정 |
| `santhosh-tekuri/jsonschema/v6` | ✓ | JSON Schema draft 4-2020-12 |

## Tier 3 — Eval/Skills (갭, Python 사이드카 정당화)

| 라이브러리 | 상태 | 처리 |
|---|---|---|
| **LLM eval (DSPy/Inspect/DeepEval 동급)** | ✗ **약함** | Go 포팅들은 초기. **Python eval 사이드카 정답** |
| 프롬프트 템플릿 | △ `text/template` + `flosch/pongo2` (Jinja2) | 충분 |
| 구조화 출력 | △ `instructor-ai/instructor-go` 공식 지원 | Python 대비 기능 lag 수주, 사용 가능 |
| **샌드박스** | △ E2B **Go SDK 없음**, Modal Go SDK 베타 | E2B HTTP 래퍼 ~200 LOC (v0 코어 경로) |

## Tier 4 — 운영

| 라이브러리 | 상태 |
|---|---|
| `santhosh-tekuri/jsonschema/v6` | ✓ |
| `air-verse/air` (hot reload) | ✓ dev only |
| `connectrpc/connect-go` (필요 시) | ✓ |
| `stretchr/testify` | ✓ |
| Testcontainers Go | ✓ |
| `log/slog` (stdlib) | ✓ |

## 직접 짤 코드 (~3주)

| 항목 | 라인 수 | 기간 |
|---|---|---|
| Langfuse REST 래퍼 | ~300 LOC | 1일 |
| E2B HTTP 래퍼 | ~200 LOC | 0.5일 |
| `agentkit` facade (Anthropic + OpenAI + MCP + Temporal 위) | ~2000 LOC | 1~2주 |
| Skills/Computer-use 헬퍼 (점진적) | - | incremental |
| (옵션) eval 하네스 | - | Python 사이드카로 우회 권장 |

**총 추가 하네스 비용**: 약 3주. 5년 유지보수 윈도우에선 무시 가능.

## 관련 ADR

- [ADR-009: 자작 agentkit](../adrs/adr-009-self-built-agentkit.md)
- [ADR-005: Langfuse + OTel](../adrs/adr-005-langfuse-otel.md)
