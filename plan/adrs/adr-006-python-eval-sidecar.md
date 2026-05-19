# ADR-006: Python eval 사이드카

**상태**: Accepted
**날짜**: 2026-05-13

## 컨텍스트

Go 컨트롤 플레인 결정 후, Skills 자기학습 + eval + 프롬프트 최적화는 Python 생태계 (DSPy, Pydantic AI, Inspect AI, DeepEval)가 훨씬 성숙. 이걸 어떻게 다룰지.

## 검토한 옵션

- **Go에서 eval 자체 구현**: DSPy/Inspect AI 없으니 직접 짬. 영구 유지비 큼.
- **Python 사이드카 (좁은 표면)**: eval/최적화만 Python, 컨트롤 플레인은 Go. 검증된 하이브리드 패턴.
- **언어 전체 Python**: 컨트롤 플레인 안전성 손해. ADR-001과 충돌.

## 결정

**Python eval 사이드카**:
- 별도 컨테이너 1개
- Go workflow가 **Temporal activity로 호출** (또는 HTTP)
- 사용자 요청 경로에 직접 위치 X — 비동기

## 책임

**Python 사이드카가 하는 것**:
- DSPy 기반 프롬프트 최적화
- Pydantic AI 기반 구조화 eval
- Inspect AI / DeepEval 회귀 테스트 스위트
- Skills 자기학습 결과 자동 채점

**책임 아님**:
- HTTP API 직접 노출 (Go가 처리)
- 테넌트 정책 / budget gate (Go가 처리)
- 카탈로그 / 라우팅 (Go가 처리)
- 영속 상태 저장 (stateless, 결과만 리턴)

## 결과

긍정:
- DSPy/Inspect AI/DeepEval/Pydantic AI 전부 사용 가능
- Python 패키징/asyncio churn이 컨트롤 플레인에 새지 않음
- 사용량 적음 → 비용·운영 부담 작음 (1~2 인스턴스 floor)

부정:
- 두 번째 배포 단위 (그러나 좁고 안정적)
- Go ↔ Python 페이로드 schema 동기화 필요 (protobuf 또는 strict JSON schema)
- cross-language 디버깅 가능 (그러나 경계 좁아서 드물 예상)

## 안 가는 길

- **Go-only eval**: DSPy 동급이 없어서 직접 짜면 영구 유지비 큼
- **Python 전체**: ADR-001 위반, 컨트롤 플레인 멀티테넌트 안전성 손해

## 패턴 참조

- Cognition (Devin) — Python control + VM sandbox
- Anyscale Agent Skills — Python eval workers
- 우리 패턴: Go control + Python eval — 보다 보수적

## 관련

- [stack/python-sidecar.md](../stack/python-sidecar.md)
- [components/skills-lifecycle.md](../components/skills-lifecycle.md)
- [ADR-001: Go primary](adr-001-language-go.md)
