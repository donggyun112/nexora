# ADR-007: Mastra 미채택

**상태**: Accepted
**날짜**: 2026-05-13

## 컨텍스트

Codex 진단으로 Nexora 철학(멀티테넌트 1급 + production-grade + architecture-pluggable + Skills 자기학습 + MCP+delegate+handraise + TS-first)에 가장 가까운 OSS는 **Mastra**로 식별됨. 22k stars, v1.0 (2026.1), Apache-2.0. 8축 중 약 5축 매칭.

## 검토한 옵션

- **Mastra fork + 확장**: 부족한 축(architecture pluggability, Skills 자기학습, 모듈성)을 자체 추가.
- **Mastra 위에 컨트롤 플레인 얇게**: Mastra가 런타임, 위에 우리 정책 레이어.
- **Mastra 미채택, 자체 빌드**: Go로 처음부터.

## 결정

**Mastra 미채택**. 자체 빌드로 진행.

이유:
1. **언어 결정**: Go primary (ADR-001). Mastra는 TS만. 갈아타도 TS 의존 가져옴.
2. **아키텍처 pluggability**: Mastra는 단일 tool-loop 지배. ReAct/Plan-Execute/Loop/DeepResearch swap 자체 추가 필요 → fork 부담.
3. **Skills 자기학습**: 카테고리 자체가 Mastra에 없음. 자체 구축 필요 동일.
4. **엔터프라이즈 RBAC paywalled**: Mastra `ee/`에 있어서 multi-tenant 거버넌스 일부 라이선스 의존.
5. **비교 노력 분석**: Mastra fork+확장 노력 ≈ Go 자체 빌드. 같은 노력이면 5년 유지보수 (ADR-001)에 더 좋은 substrate 선택.

## 결과

긍정:
- Go 자산 + 컴파일 안전성 + Temporal 1st-party
- 락인 X
- 우리 7개 컨셉이 1급 파라미터로 박힘

부정:
- 약 3주 추가 자작 코드 (agentkit harness)
- Mastra 커뮤니티/도구 생태계 못 받음 (Go 진영에서 따로 구축)

## Mastra의 진짜 강점 (반대편 균형 검토)

- 22k stars, 주 30만 npm = 큰 커뮤니티
- v1.0 안정, Apache-2.0
- RequestContext + agent-approval + OTel suspend/resume = 우리 요구 중 일부 만족
- DeepAgents 기능 emerging — 향후 architecture pluggable 추가될 가능성

→ Mastra가 우리 8축을 모두 만족하게 되면 v2+에서 재평가 가능. 단 현재 갭이 크므로 자체 빌드 정당화.

## 안 가는 길

- **Mastra fork**: TS 의존 영구화 + 우리 컴파일 안전성 손해. fork 동기화 영구 부담.
- **Mastra 위에 얇게**: TS 컨트롤 플레인 → ADR-001 위반.

## 재검토 트리거

다음 중 하나라도 발생 시 ADR 재검토:
- Mastra가 우리 7개 컨셉을 1년 안에 1급으로 지원 + Go 변종 출시
- Go 자작 코드 유지비가 예상의 3배 초과
- 외부 사용자가 Mastra 호환성을 강하게 요구

## 관련

- [stack/language.md](../stack/language.md)
- [philosophy.md](../philosophy.md)
- [ADR-001: Go primary](adr-001-language-go.md)
- [ADR-009: 자작 agentkit](adr-009-self-built-agentkit.md)
