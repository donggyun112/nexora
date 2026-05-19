# ADR-004: MCP를 도구 표준으로

**상태**: Accepted
**날짜**: 2026-05-13

## 컨텍스트

에이전트가 사용할 도구를 어떤 표준으로 정의·통합할지.

## 검토한 옵션

- **MCP** (Model Context Protocol): Anthropic 발의, Google·OpenAI 채택. 공식 Go SDK 2025년 출시.
- **자체 도구 인터페이스**: 완전 제어. 단 외부 도구 ecosystem 못 받음.
- **OpenAI function calling 그대로**: OpenAI lock-in.
- **Anthropic tool_use 그대로**: Anthropic lock-in.

## 결정

**MCP를 표준 도구 프로토콜로**, agentkit이 provider-specific 포맷(Anthropic tool_use / OpenAI tool_calls)으로 변환.

이유:
1. 표준화 빠르게 진행 중 — Anthropic + Google + OpenAI 공동 지원
2. 공식 Go SDK (`modelcontextprotocol/go-sdk`) 존재, Google과 공동 유지
3. **테넌트 BYOMCP** (Bring Your Own MCP) 가능 — 테넌트가 자기 MCP 서버 추가
4. 외부 도구 ecosystem 무료로 받음 (search engines, DBs, dev tools 등)

## 결과

긍정:
- 표준 server/client 분리로 도구 재사용성 극대화
- 테넌트별 MCP 서버 추가 가능
- 도구 발견 / 등록 / 호출이 통일된 인터페이스

부정:
- agentkit 내부에 provider 포맷 변환 코드 (Anthropic / OpenAI 각각)
- MCP가 아직 진화 중 — spec 변경에 대응 필요

## 도구 3대 primitive

[components/tools.md](../components/tools.md) 참조:
1. **MCP** — 표준 도구 (외부/내부)
2. **delegate** — 다른 에이전트로 위임 (Temporal child workflow)
3. **handraise** — 사람으로 escalate (signal-wait workflow)

세 가지 모두 같은 정책 게이트(allowlist + budget + audit) 통과.

## 안 가는 길

- **자체 인터페이스 단독**: 외부 도구 ecosystem 손해 너무 큼
- **OpenAI/Anthropic-only**: vendor lock-in, 다른 provider 추가 시 인터페이스 재작성

## 관련

- [components/tools.md](../components/tools.md)
- [stack/go-libraries.md](../stack/go-libraries.md)
