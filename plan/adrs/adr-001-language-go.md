# ADR-001: 메인 언어 = Go, eval은 Python 사이드카

**상태**: Accepted
**날짜**: 2026-05-13

## 컨텍스트

기존 TS Nexora 19 패키지 폐기 후 새로 빌드. 언어 선택이 5년 유지보수 + 솔로/소수 팀 dev velocity에 가장 큰 영향.

## 검토한 옵션

- **TS** (기존 자산 유지, Mastra 위에): 학습 비용 적음. 단 Mastra가 Skills 자기학습·architecture pluggability·멀티테넌트 1급을 다 제공하지 못함. 갈아타도 비슷한 노력.
- **Python**: AI SDK 1st-party. eval 생태계 강함. 단 컨트롤 플레인 작업에서 compile-time 멀티테넌트 안전성 약함. 5년 패키징/asyncio churn 우려.
- **Go**: 컨트롤 플레인 작업에 최적. Temporal 1st-party. 5년 호환 약속. compile-time 안전성. 단 LLM/eval 생태계 Python 대비 lag.
- **Rust**: 메모리 안전 + 성능 최강. 단 Temporal app-level SDK pre-release. 솔로/소수 팀에 dev velocity 손해 큼.

## 결정

**Go primary + Python eval 사이드카**

이유:
1. 우리는 "에이전트" 아니라 "에이전트 플랫폼"을 만듦 — 작업 비중 70% 인프라 / 30% ML-adjacent
2. 멀티테넌트 compile-time 안전성이 가장 중요한 비용 분류 (tenant 데이터 누설 = 사업 종료)
3. Temporal Go SDK가 가장 두꺼움 (Replit/Scale AI 검증)
4. Go 1.x 호환 약속이 5년 유지보수에 결정타
5. eval 생태계 갭은 Python 사이드카로 정확히 격리 (요청 경로 밖)

## 검증 — 라이브러리 감사

Tier 1 deal-breaker 없음:
- temporalio/sdk-go ✓
- anthropic-sdk-go ✓ (공식)
- openai-go ✓ (공식)
- modelcontextprotocol/go-sdk ✓ (공식, 2025)
- OTel Go ✓
- pgx/v5 + pgvector-go ✓

워크어라운드:
- Langfuse Go SDK 없음 → REST 래퍼 ~300 LOC
- E2B Go SDK 없음 → HTTP 래퍼 ~200 LOC
- LLM eval 생태계 약함 → Python 사이드카

총 자작 코드 ~3주.

## 결과

긍정:
- 5년 호환성 / 운영 디버깅 / 단일 바이너리 / 멀티테넌트 컴파일 안전성 확보
- Temporal 패턴 검증된 경로 따라감
- Python 사이드카로 eval 생태계 활용

부정:
- TS 코드 자산 100% 폐기 (그러나 7개 컨셉만 가져가는 결정과 일치)
- 새 LLM provider 기능 D-0 채택 lag (수주, agentkit이 우회)
- Python 사이드카가 두 번째 배포 단위 (그러나 좁은 표면)

## 안 가는 길

- **Python 전체**: 12개월 출시 후 멀티테넌트 정확성 사고 위험. 5년 유지보수 비용 더 큼.
- **Rust 전체**: 솔로/소수 팀이 v0/v1 동안 dev velocity 못 받침. v2+에 좁은 hot path만 검토.
- **TS 유지**: 비슷한 Mastra fork+확장 노력이면 더 좋은 substrate에 옮기는 게 합리적.

## 관련

- [stack/language.md](../stack/language.md)
- [ADR-002: Temporal](adr-002-temporal-durable-execution.md)
- [ADR-006: Python eval 사이드카](adr-006-python-eval-sidecar.md)
