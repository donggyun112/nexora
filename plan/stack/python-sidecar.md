# Python eval 사이드카

## 정체

작은 Python 서비스 1개. Go 컨트롤 플레인이 **Temporal activity로 호출**. 사용자 요청 경로에 직접 위치하지 않음.

## 책임 (이것만)

- DSPy 기반 프롬프트 최적화
- Pydantic AI 기반 구조화 eval
- Inspect AI / DeepEval 기반 회귀 테스트 스위트
- Skills 자기학습 결과의 자동 채점

## 책임 아님

- HTTP API 직접 노출 (Go가 처리)
- 테넌트 정책 / budget gate (Go가 처리)
- 카탈로그 / 라우팅 (Go가 처리)
- 데이터 저장 (결과는 Postgres 또는 Langfuse로)

## 호출 경계

```
Go workflow (EvalRunWorkflow)
   │
   ▼ workflow.ExecuteActivity(ctx, CallPythonEval, request)
   │
[Go activity: callPythonEval]
   │
   ▼ HTTP POST or gRPC to python sidecar
   │
[Python sidecar]
   - Pydantic AI runner
   - DSPy optimizer
   - 결과 JSON 반환
   │
   ▼
[Go activity 종료, 결과 Postgres에]
```

## 기술 스택

| 컴포넌트 | 라이브러리 |
|---|---|
| 에이전트 SDK (사이드카 내부) | **Pydantic AI** |
| Eval suite | Inspect AI 또는 DeepEval |
| 프롬프트 최적화 | DSPy |
| HTTP 서버 | FastAPI |
| 도구 | uv (패키지 관리), ruff (린트), pyright (타입) |

## 배포

- 별도 컨테이너 1개 (v0)
- Stateless — Postgres/Langfuse 직접 안 쓰고 결과만 Go에 리턴
- 사용량 적음 → 항상 1~2 인스턴스 floor, autoscale

## 왜 분리했나

| 이유 | 설명 |
|---|---|
| 생태계 격리 | Python 패키징/asyncio churn이 Go 컨트롤 플레인에 새지 않음 |
| 컴파일 안전성 격리 | Go의 멀티테넌트 compile 안전성 보존 |
| eval 워크로드 특성 | 배치성, 길게 도는 작업이 많아 요청 경로 부적합 |
| 도구 생태계 | DSPy/Inspect AI/DeepEval은 Python에서만 진지하게 작동 |

## 인터페이스 안정성

Go ↔ Python 사이의 페이로드는 **protobuf 또는 strict JSON schema**로 잠금:

- 변경 시 양쪽 모두 마이그레이션 워크플로 필요
- Go 워크플로 버저닝 + Python schema 버저닝 함께 진행
- 양쪽이 같은 commit 안에 변경되는 게 정상

## 안 할 일 (사이드카 scope creep 방지)

- Python 사이드카가 다른 서비스에 직접 RPC 하지 않음
- Python이 LLM 호출하면 비용은 **Go 워크플로가 budget gate 통과**한 후만
- Python이 도구 호출 안 함 (도구는 Go agentkit이 처리)
- Python에 영속 상태 두지 않음 (stateless)
