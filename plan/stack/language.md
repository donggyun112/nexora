# 언어 결정

## 결론

**Go 메인 + Python eval 사이드카**

## 의사결정 경로

1. TS 포기 (Mastra가 가장 가까우나 Skills 자기학습·architecture pluggability 직접 구축해야 → 동일 노력이면 더 좋은 substrate 선택)
2. Python vs Go 비교 → 70/30 인프라/ML 분할로 Go 우세
3. Rust 평가 → v0/v1엔 dev velocity 손해. v2+ hot path만 후보
4. 5-criterion 프레임워크 적용 + 라이브러리 감사 통과 → Go 확정

## Go가 이긴 이유 (Temporal 의존 제외해도)

| 논거 | Temporal 의존? |
|---|---|
| 70% 인프라/30% ML 분할 — 우리는 플랫폼 빌더 | 독립 |
| 멀티테넌트 compile-time 안전성 (tenant_id 누설 차단) | 독립 |
| 3시 새벽 디버깅 (pprof, race detector, 단일 바이너리) | 독립 |
| 5년 유지보수 (Go 1.x 호환 약속) | 독립 |
| Python eval 사이드카 하이브리드 | 독립 |
| Skills/eval에 DSPy/PydanticAI 불필수 | 독립 |
| **Temporal Go SDK 레퍼런스 경로** | 의존 |

→ 7개 중 6개가 Temporal 독립 논거. Temporal 빼도 Go 우세.

## Python을 사이드카로만 격리한 이유

- DSPy, Inspect AI, DeepEval, Pydantic AI 등 **eval/optimization 생태계는 Python-first**
- 단 이 작업은 **요청 경로 밖** — 비동기로 Temporal activity 호출
- 컨트롤 플레인을 Python으로 두면 멀티테넌트 compile 안전성·ops 디버깅·5년 유지보수 모두 손해
- Cognition, Anyscale 등 검증된 하이브리드 패턴

## Rust 유예 사유

- Temporal Rust SDK는 app-level pre-release (2026.5 기준)
- Anthropic Rust SDK 비공식, eval 생태계 없음
- 솔로/소수 팀 dev velocity가 v0 12개월 압력 하에 결정타
- **단** v2+ 측정된 hot path 병목 발견 시 좁은 컴포넌트(WASM 샌드박스, gateway, 토큰 카운터)만 Rust로 빼는 옵션 보존 — Linkerd 패턴

## 검증된 패턴

| 회사 | 스택 | 사용처 |
|---|---|---|
| OpenAI | Python + Temporal | Agents SDK 컨트롤 |
| Replit | Go + Temporal | 코딩 에이전트 |
| Scale AI | Go + Temporal | 에이전트 컨트롤 플레인 |
| Grid Dynamics | LangGraph+Redis → **Temporal로 마이그레이션** (재시도 코드 수천 줄 삭제) | |
| Cognition (Devin) | Python control + VM 샌드박스 + 압축 LLM | |

우리는 Replit/Scale AI 패턴에 가까움.

## 관련 ADR

- [ADR-001: Go primary](../adrs/adr-001-language-go.md)
- [ADR-006: Python eval 사이드카](../adrs/adr-006-python-eval-sidecar.md)
