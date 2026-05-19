# ADR-008: chi를 HTTP 프레임워크로

**상태**: Accepted
**날짜**: 2026-05-13

## 컨텍스트

Go에 다양한 HTTP 프레임워크 존재. 멀티테넌트 컨텍스트 전파 + 풍부한 미들웨어 합 + net/http 호환이 필요.

## 검토한 옵션

- **chi**: 미니멀, net/http 네이티브, 미들웨어-first
- **echo**: 배터리 포함, 자체 컨텍스트 모델
- **gin**: 인기, 빠름, 자체 컨텍스트 모델
- **fiber**: Express 스타일, fasthttp (net/http 비호환)
- **huma**: OpenAPI-first 프레임워크
- **순수 net/http (1.22+)**: 표준 only, 그룹/미들웨어 직접 구현
- **connect-go**: RPC-first

## 결정

**chi** 1픽.

이유:
1. **net/http 네이티브**: Temporal, OTel, WorkOS, MCP 미들웨어 전부 net/http 가정. chi는 그대로 호환.
2. **미들웨어-first 설계**: tenant resolve, auth, audit, budget gate, rate limit 미들웨어 깔끔하게 체인.
3. **컨텍스트 전파**: `context.Context`만 사용. 자체 모델 안 강요.
4. **소규모 팀 친화**: 학습곡선 거의 없음. 새 멤버 즉시 이해.
5. **유지보수 5년**: 활발하고 변동 적음. 1.x 호환.

## 결과

긍정:
- 미들웨어 체인이 우리 멀티테넌트 정책을 자연스럽게 표현
- 모든 net/http 기반 라이브러리 그대로 사용
- SSE 스트리밍이 표준 `http.ResponseWriter`로 직접 처리 가능

부정:
- 자체 기능 적음 (rate limit, JWT, OpenAPI 등 별도 라이브러리 조합)
- huma처럼 OpenAPI 자동 생성 X (manual 또는 별도 도구)

## 후보 비교

| 프레임워크 | net/http | 컨텍스트 | 미들웨어 | OpenAPI | 결정 |
|---|---|---|---|---|---|
| **chi** | ✓ | stdlib | 1급 | manual | **1픽** |
| huma | ✓ | stdlib | 1급 | 자동 | 2픽 (추상 더 큼) |
| echo | ✓ | 자체 | 자체 모델 | 라이브러리 | 자체 컨텍스트 색깔 |
| gin | ✓ | 자체 | 자체 | 라이브러리 | 동일 |
| fiber | ✗ (fasthttp) | 자체 | 자체 | 자체 | net/http 비호환 |
| connect-go | ✓ | stdlib | 1급 | proto-driven | 외부 API용으론 부적합 |
| net/http only | ✓ | stdlib | 직접 | manual | 그룹/미들웨어 재발명 |

## 외부 API 모양

**REST JSON + SSE**:
- REST: 자원 CRUD (tenants, agents, skills, sessions, ...)
- SSE: 에이전트 run 이벤트 (run.started, llm.token, tool.called, ...)
- POST: interrupt, cancel, resume
- gRPC는 외부 API 아님
- Connect-RPC는 내부 서비스 경계 생길 때만

## 안 가는 길

- **Fiber**: net/http 비호환 = Temporal/OTel/WorkOS 미들웨어 깨짐 = deal-breaker
- **Gin/Echo**: 자체 컨텍스트 모델 강요 → 매 통합마다 어댑터 코드
- **huma**: 좋은 후보지만 v0에 추상 레이어 과함. v1+ 재검토
- **순수 net/http**: 그룹/미들웨어 ergonomics 직접 구현 = chi 재발명

## 관련

- [stack/README.md](../stack/README.md)
- [architecture/data-flow.md](../architecture/data-flow.md)
