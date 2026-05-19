# ADR-002: Temporal을 durable execution으로

**상태**: Accepted
**날짜**: 2026-05-13

## 컨텍스트

에이전트 플랫폼의 핵심 워크로드 — agent run, Skill 자기학습, 카탈로그 롤아웃 — 모두 다단계 + 외부 호출 + 길게 도는 작업. 크래시 시 토큰 다시 안 태우고 재개되어야 함.

## 검토한 옵션

- **Temporal**: durable execution의 사실상 표준. $5B valuation, OpenAI/Replit/Scale AI 사용. Go SDK 1st-party.
- **Inngest**: TS-first durable functions. 가볍고 빠른 시작.
- **Restate**: 신생, 2026.3 상용 런칭. 가장 가벼움.
- **자체 (Postgres + Redis 기반 DIY)**: 의존성 최소. 단 ~2-3주 자체 구현 + 영구 유지비.
- **없음 (단순 retry 루프)**: 짧은 워크플로엔 OK. 긴 워크플로엔 토큰 다시 태우는 비용 큼.

## 결정

**Temporal Cloud (v0) → 향후 자체 호스팅 검토**

이유:
1. **검증된 운영 사례**: OpenAI Frontier, Replit 코딩 에이전트, Scale AI 모두 공개적으로 사용
2. **Go SDK가 가장 두꺼움**: 우리 언어 결정과 정합 (ADR-001)
3. **에이전트 패턴에 정확히 맞음**: signals (사용자 cancel), child workflows (handoff), long-running (휴먼 승인 대기)
4. **history replay**: 디버깅·재현성·테스트가 1급
5. **Grid Dynamics 마이그레이션 사례**: LangGraph+Redis → Temporal 후 retry/error 코드 수천 줄 삭제

## 결과

긍정:
- 워크플로 영속·재시도·취소·시그널 무료
- 에이전트 sessions = workflows 깔끔 매핑
- Temporal Web UI = 디버깅 무료

부정:
- 별도 의존성 (Temporal Cloud ~$200/월 또는 자체 호스팅 ~5GB RAM)
- 학습 곡선: workflow deterministic 규율, activity idempotency, 버저닝
- 워크플로 코드 변경 시 진행 중 워크플로 안 깨뜨리는 규율 필요

## 결정한 규율

- 워크플로 입력에 `tenant_id` 필수 필드
- Activity는 idempotent + timeout + retry policy 명시
- `workflow.GetVersion()` 으로 코드 변경 안전 보장
- Task queue 분리 (`agent-runs`, `eval-runs`, `cron` 등)

## 안 가는 길

- **자체 Postgres+Redis durable execution**: 2-3주 자체 + 영구 유지비. 기능 부족 (signals, child, replay). Temporal 무료 OSS 셀프호스트로 충분.
- **Inngest**: TS-first라 우리 Go 컨트롤 플레인과 매칭 약함. Inngest Go SDK 있으나 reference 적음.
- **없음**: 긴 워크플로(휴먼 승인 대기 7일 등) 못 받침.

## 관련

- [stack/infrastructure.md](../stack/infrastructure.md)
- [components/workflows.md](../components/workflows.md)
- [ADR-001: Go primary](adr-001-language-go.md)
