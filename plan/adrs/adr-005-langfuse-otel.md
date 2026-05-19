# ADR-005: Langfuse 셀프호스트 + OTel

**상태**: Accepted
**날짜**: 2026-05-13

## 컨텍스트

관찰성 신호는 3종류: 분산 trace/metric, LLM-specific trace(프롬프트·응답·비용), 구조화 로그.

## 검토한 옵션

- **OTel만**: 표준, vendor-neutral, Tempo/Honeycomb로 자유. 단 LLM-specific UX 약함.
- **Langfuse만**: LLM trace UX 최강. 단 분산 trace는 따로.
- **Langfuse 클라우드**: 운영 부담 X. 비용 + 락인.
- **Datadog LLM Obs**: 통합 잘 됨. 비싸고 락인.
- **자체 구축**: 비추, 운영 부담 무한.

## 결정

**Langfuse 셀프호스트 + OTel 표준** 조합.

- 분산 trace / metric / 일반 로그 → OTel (Tempo + Loki, 또는 Honeycomb)
- LLM 프롬프트 / 응답 / 비용 / eval → **Langfuse 셀프호스트**
- 구조화 로그 → `log/slog` JSON → Loki

이유:
1. Langfuse Go SDK 없음 → REST 래퍼 ~300 LOC. 셀프호스트라 락인 X
2. OTel은 industry 표준, 어떤 backend든 교체 가능
3. 두 시스템 분리해서 신호별 최적화 (LLM trace ≠ 일반 trace)
4. 비용 — 셀프호스트로 모든 LLM 호출 trace 가능

## 결과

긍정:
- 락인 최소
- LLM 호출 단위로 prompt/response/cost/version 분석 가능
- OTel로 다른 backend 자유 교체 (Honeycomb 시도 등)

부정:
- 두 개 시스템 운영
- Langfuse 셀프호스트 자체가 추가 인프라 부담

## 한 LLM 호출의 데이터 흐름

```
agentkit.callLLM(ctx, prompt)
   ├── OTel span 시작 (분산 trace)
   ├── Anthropic/OpenAI 호출
   ├── 응답 받음
   ├── Langfuse REST: POST /api/public/generations
   │     { input, output, model, tokens, cost, ... }
   ├── OTel span 종료 (라벨에 tokens/cost 포함)
   ├── audit DB 기록
   └── 리턴
```

3개 시스템에 정보가 가지만 각자 다른 보존 기간·접근 권한·query 패턴.

## 관련

- [operations/observability.md](../operations/observability.md)
- [stack/go-libraries.md](../stack/go-libraries.md)
