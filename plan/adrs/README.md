# Architecture Decision Records

각 결정의 컨텍스트·옵션·근거를 보존. 미래 너 또는 합류자가 "왜 X로 했지?"를 1분 안에 알 수 있게.

## 인덱스

| ID | 제목 | 상태 |
|---|---|---|
| [ADR-001](adr-001-language-go.md) | 메인 언어 = Go, eval은 Python 사이드카 | Accepted |
| [ADR-002](adr-002-temporal-durable-execution.md) | Temporal을 durable execution으로 | Accepted |
| [ADR-003](adr-003-postgres-pgvector.md) | Postgres + pgvector (별도 vector DB X) | Accepted |
| [ADR-004](adr-004-mcp-tools.md) | MCP를 도구 표준으로 | Accepted |
| [ADR-005](adr-005-langfuse-otel.md) | Langfuse 셀프호스트 + OTel | Accepted |
| [ADR-006](adr-006-python-eval-sidecar.md) | Python eval 사이드카 (Pydantic AI + DSPy) | Accepted |
| [ADR-007](adr-007-mastra-not-adopted.md) | Mastra 미채택 | Accepted |
| [ADR-008](adr-008-chi-http-framework.md) | chi를 HTTP 프레임워크로 | Accepted |
| [ADR-009](adr-009-self-built-agentkit.md) | 자작 agentkit (OpenAI Agents SDK 비채택) | Accepted |

## ADR 포맷

```markdown
# ADR-NNN: 제목

**상태**: Proposed / Accepted / Deprecated / Superseded by ADR-NNN
**날짜**: YYYY-MM-DD
**결정자**: (이름들)

## 컨텍스트
무엇이 결정을 강제했나

## 검토한 옵션
- 옵션 A: ...
- 옵션 B: ...
- 옵션 C: ...

## 결정
선택한 옵션 + 이유

## 결과
긍정적 / 부정적 결과

## 안 가는 길
대안의 진짜 비용 (왜 안 가는지)
```
