# 가져갈 7개 컨셉

코드는 다 버린다. 이 7개만 새 코드베이스에 살아남는다.

## 1. 테넌트는 1급 primitive

같은 바이너리가 테넌트마다 다른 페르소나·도구 allowlist·모델·budget·한도를 가짐. **사후 보강 아님, 태생부터**.

- 모든 쿼리, 캐시 키, rate 키, trace 라벨, 로그 라인, tool 호출이 `tenant_id`를 필수 파라미터로 받음
- `context.Context`로 자동 전파, 미들웨어로 강제
- 의도적 비-테넌트 코드는 명시적으로 표시 (예: 시스템 관리자 작업)

→ 실패 모드: tenant ID 누설. 컴파일 타임에 잡는 게 Go 채택 핵심 이유 중 하나.

## 2. Pre-execution budget gate

알람 아니라 **차단**. 모든 LLM 호출·tool 호출 직전에 통과해야 함.

- 단위: `agent_id × tenant_id`
- 차단 모드: hard stop / warn / log-only (테넌트 설정)
- 초기화: 일/월 cron 워크플로
- 산업 사례에서 $47K/$4,200 사고 모두 "monitoring without enforcement"가 원인

→ Pre-call enforcer가 우리의 가장 강한 차별점 중 하나.

## 3. Skills 자기학습 라이프사이클

Anthropic Skills 스키마 위에 **자기학습 메커니즘**을 얹음. 단순 카탈로그가 아니라:

```
agent가 패턴 발견
  → SKILL.md 자동 생성 (provenance 기록)
  → eval (Python 사이드카가 채점)
  → human approval (Temporal workflow가 대기)
  → version pin (semver, immutable)
  → tenant override (테넌트별 활성화/비활성화)
  → rollback (포인터 스왑)
```

각 단계가 Temporal workflow + Postgres state로 관리.

## 4. Architecture-pluggable

ReAct / Plan-Execute / Loop / Deep Research가 **같은 런타임에서 교체**.

- agent manifest에서 `architecture` 필드로 선택
- agentkit이 strategy 패턴으로 라우팅
- 같은 tenant/budget/tool 정책이 모든 arch에 자동 적용
- 새 arch 추가 = strategy 구현체 1개 추가

## 5. Tools = MCP + delegate + handraise

세 가지 도구 primitives:

- **MCP**: 표준 도구 ecosystem (`modelcontextprotocol/go-sdk`)
- **delegate**: agent → agent capability-based 위임 (Temporal child workflow)
- **handraise**: agent → human escalation (signal 대기 워크플로)

모든 tool 호출이 동일한 정책 게이트(allowlist + budget + audit) 통과.

## 6. Conversation protocol = 모듈 1개

멀티에이전트 대화(누가 답할지)는 **하나의 옵셔널 모듈**. 프레임워크 정체성 아님.

- 단일 linear 에이전트가 기본
- 멀티에이전트는 deliberation 필요한 도메인(정책 자문, 의료 합의 등)에만 활성화
- Cognition/Shopify의 "Don't build multi-agents" 컨센서스 존중

## 7. Production concerns = 1st-class

옵션이 아니라 코어에 박힘:

- OTel tracing (모든 LLM/tool/handoff 자동 span)
- Budget 강제 (pre-call enforcer)
- 영속 워크플로 (Temporal)
- 스마트 LLM fallback (provider 에러 분류 + 자동 재시도/대체)
- 샌드박싱 (E2B HTTP)
- 감사 로그 (Postgres immutable ledger)

## 무엇을 안 가져가나

- TS 19개 패키지의 코드 자체
- 자작 transport (Redis는 그대로 쓰되 추상은 새로)
- 자작 WorkflowEngine (Temporal로 대체)
- 자작 OTel transport (표준 OTel 직접)
- 자작 store 6-store 추상 (Postgres 직접)

이건 다 Codex 진단 "self-flattering 매핑"의 결과 — 진짜 production OSS가 더 잘하는 일들. 우리가 짤 가치 없음.
