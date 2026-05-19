# 스택 매니페스트

| 레이어 | 컴포넌트 | 라이브러리/서비스 | 비고 |
|---|---|---|---|
| 언어 | 메인 백엔드 | **Go** | [language.md](language.md) |
| 언어 | eval/최적화 사이드카 | Python | [python-sidecar.md](python-sidecar.md) |
| Durable execution | 워크플로 | Temporal Go SDK | [../adrs/adr-002-temporal-durable-execution.md](../adrs/adr-002-temporal-durable-execution.md) |
| HTTP | 라우터 | **chi** | net/http 네이티브 |
| 공개 API | 모양 | **REST JSON + SSE** | gRPC 외부엔 안 씀 |
| 내부 RPC | 옵션 | connect-go | 필요할 때만 |
| 에이전트 런타임 | facade | **자작 `agentkit`** | [../components/agent-runtime.md](../components/agent-runtime.md) |
| LLM SDK | 모델 API | anthropic-sdk-go, openai-go | 공식 |
| 구조화 출력 | 추출 | instructor-go | type-safe |
| MCP | 도구 프로토콜 | modelcontextprotocol/go-sdk | 공식 |
| DB | 주 저장소 | **Postgres** | [infrastructure.md](infrastructure.md) |
| 벡터 검색 | 임베딩 | pgvector | v0엔 충분 |
| DB 드라이버 | SQL | pgx/v5 | de facto |
| 마이그레이션 | 스키마 | goose | |
| 캐시 | Redis | go-redis/v9 | rate counter + ephemeral |
| Rate limit | per-tenant | Redis 백드 limiter | Cloudflare는 엣지만 |
| 백그라운드 잡 | 작업 | **Temporal** | 별도 큐 금지 |
| 관찰성 | LLM trace | Langfuse REST 래퍼 (자작 ~300 LOC) | |
| 관찰성 | tracing/metrics | OpenTelemetry | OTel Collector → Tempo |
| 로깅 | 구조화 로그 | **`log/slog` JSON** | stdlib |
| 인증 | B2B | WorkOS Go SDK **v7** | SSO/SCIM/RBAC |
| 설정 | 런타임 | koanf/v2 | viper보다 깔끔 |
| 시크릿 | 저장 | 클라우드 SM + envelope 암호화 | |
| 검증 | 요청/도메인 | validator + jsonschema/v6 | |
| 에러 | API | 타입드 `apperr` + RFC 9457 problem JSON | |
| CLI | 운영/개발 | cobra | |
| 샌드박스 | 코드/도구 | **E2B HTTP 래퍼** (~200 LOC) | Modal Go beta는 v0 코어 경로 외 |
| 개발 리로드 | 로컬 | air | |
| 피처 플래그 | flags | OpenFeature + 간단 provider | |
| 이메일/알림 | 알림 | Postmark/Resend (Temporal 경유) | |
| 엣지 | 보호/라우팅 | Cloudflare | |
| 테스트 | 베이스 | stdlib testing + httptest + testify/require + **Testcontainers** | |
| 미래 hot path | 시스템 컴포넌트 | Rust 유예 (v2+) | WASM 샌드박스 등 |

## 결정 근거 파일

- 언어: [language.md](language.md)
- Go 라이브러리 감사: [go-libraries.md](go-libraries.md)
- Python 사이드카 경계: [python-sidecar.md](python-sidecar.md)
- 인프라 (Postgres/Redis/Temporal/Cloudflare/WorkOS): [infrastructure.md](infrastructure.md)

## 안 쓰기로 한 것

| 후보 | 안 쓴 이유 |
|---|---|
| Mastra | TS 진영 1픽이지만 우리가 Go로 감 + ADR-007 참조 |
| LangGraph(Go 포팅) | 컨트롤 노출 부족, Python 대비 lag 심각 |
| Genkit Go | Google AI 색이 옵션 강제, 우리 요구엔 facade가 더 깔끔 |
| Eino (ByteDance) | 커뮤니티 작고 지정학적 리스크 |
| nlpodyssey/openai-agents-go | 1인 메인테이너 리스크 |
| Fiber | net/http 비호환 (Temporal/OTel/WorkOS 미들웨어 깨짐) |
| Gin/Echo | 자체 컨텍스트 모델 강요 |
| Viper | koanf가 더 깔끔 |
| GORM | 무거움. pgx + sqlc 또는 raw SQL 선호 |
