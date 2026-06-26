# Nexora 서브모듈 문서 — agent-first 재정비 (Design)

- **Date:** 2026-06-26
- **Status:** Draft (pending user review)
- **Audience of the work product:** coding agents (LLM) — *not* human newcomers
- **Author:** 설계 협업 (brainstorming)

---

## 1. 목표 (Goal)

Nexora의 각 서브모듈 문서(README)를 **coding agent가 소스를 열지 않고도 패키지를 정확히·즉시 활용**하도록 재정비한다. 사용자 원문: *"coding agent가 존나 잘 쓰고 활용하는 패키지로 만드는 게 목표"*.

"불친절"의 측정 기준은 사람 온보딩이 아니라 **에이전트 소비성(agent-consumability)**:
> 에이전트가 README만 믿고 따라 했을 때, (a) 설치/임포트가 실제로 성공하고, (b) 올바른 패키지를 골라, (c) 동작하는 코드를 붙여넣을 수 있는가.

## 2. 문제 (Problem) — 근거와 함께

사용자가 지목한 세 가지:

1. **③ 코드와 drift (정확성).** 실제 패키지명은 전부 `@dongkseo/*` (package.json 20개 확인). 그러나 루트 `README.md`·`docs/getting-started.md`·`platform/*` stub·일부 `docs/architecture/*`는 `@nexora/*`로 표기. 에이전트가 `pnpm add @nexora/core`를 그대로 실행하면 **설치 실패**. → agent-first 관점에서 가장 치명적.
   - 배경: `@nexora`는 의도한 npm org지만 생성하지 못해 현재 `@dongkseo`를 사용. 즉 "지금 설치되는 이름"은 `@dongkseo`가 정답.
   - 브랜드/제품명 "Nexora"와 CLI **명령어** `nexora`(`platform/cli` bin)는 정상 — 교정 대상 아님.
   - `@nexora/` 등장: 라이브 문서 + 과거 기록물 합쳐 16개 파일.

2. **② 전체를 잇는 지도 부재.** 각 README는 자기 패키지만 설명. 17+3개 패키지가 어떻게 한 시스템이 되는지(의존 방향·계층 흐름·"언제 뭘 import")가 한곳에 없음. 루트 README에 부분적으로 있으나 `<details>`로 접혀 있고 이름도 `@nexora`로 틀림. 에이전트가 "X를 하려면 어느 패키지?"를 풀 수 없음.

3. **① platform stub 3개.** `platform/cli`·`gateway`·`registry` README가 18줄(제목·Install·Tests뿐). 실제로는 기능이 많음(gateway: router·streaming-router·middleware; registry: InMemoryAgentRegistry; cli: create/dev/doctor/dlq/budget/handraise/export/import). 에이전트에게 아무 정보도 못 줌.

대조군: `packages/*` 17개 `@dongkseo/*` README는 이미 충실한 공통 템플릿(무엇/아닌가 · 핵심개념표 · 사용레시피 · API표면 · 유지보수)을 따르며 이름도 정확. **이 템플릿이 목표 품질의 기준선이자 정본.**

## 3. 비목표 (Non-goals)

- 패키지 **rename 안 함**(`@dongkseo`→`@nexora`로 코드 변경 X). 문서만 교정.
- 사람 온보딩용 산문/튜토리얼 확장 안 함. 스타일은 현행 밀도 높은 agent 지향 유지(사용자가 "사람이 읽기 어려움"은 문제로 꼽지 않음).
- 과거 기록물 재작성 안 함: `docs/superpowers/plans/*`, `plan/**` 는 point-in-time 기록 → 손대지 않음.
- 리치 17개 README의 **줄단위 전수 감사 안 함**(스팟체크만; 진짜 drift 발견 시 해당 패키지만 교정).

## 4. 품질 기준 (Agent-consumability checklist)

모든 대상 문서가 만족해야 하는 불변식:

- [ ] **Copy-paste-safe:** 모든 설치/임포트 식별자가 실제 설치 가능한 이름(`@dongkseo/*`).
- [ ] **동일 골격:** 정해진 섹션 순서/제목을 따른다(§6) → 에이전트가 슬롯 위치로 추출 가능.
- [ ] **경계 명시:** "무엇이 아닌가" + 의존 방향이 있어 잘못된 패키지 import를 막는다.
- [ ] **타입은 포인터로:** 본문에 시그니처를 베끼지 않고 `ctx_read(path, mode=signatures)` 경로로 안내(정본=소스 TSDoc, drift 최소화).
- [ ] **레시피는 실제 코드:** 임포트 포함, 최소·자족적, 실재 export만 사용.
- [ ] **단일 진입점에서 도달 가능:** 루트 `AGENTS.md` → 지도 → 패키지 README → signatures 로 라우팅된다.

## 5. 작업 범위 (Workstreams)

우선순위 = agent 영향도 순.

### P0 — 정확성 교정 (③)
- 라이브 문서의 `@nexora/<pkg>` → `@dongkseo/<pkg>` 치환. 대상:
  - `README.md`, `docs/getting-started.md`
  - `docs/architecture/*.md` 중 **설치/임포트·패키지 식별자** 맥락 (브랜드 "Nexora" 서술은 유지; 케이스별 판단)
  - `platform/{cli,gateway,registry}/README.md` (P1 확장 시 함께 교정)
  - `examples/personal-assistant/README.md`
- 치환 규칙: **패키지 식별자** `@nexora/x`만 교정. 브랜드 "Nexora", CLI 명령 `nexora`는 보존.
- 깨진 내부 링크 점검(현재 `docs/architecture/public-api.md`는 존재 확인됨 — 추가 점검만).
- **제외:** `docs/superpowers/plans/*`, `plan/**`, `.git/*`.

### P1 — 통합 지도 (②): `docs/architecture/packages-map.md` (신규)
에이전트 라우팅 인덱스로 설계. 구성:
1. **Capability → Package → 핵심 export → signatures 경로** 표 (루트 README "When you need…/Add…"를 정본화·확장; `@dongkseo`).
2. **의존 방향 그래프** (mermaid): 허용된 import 방향. 핵심 규칙 `core → contracts` 단방향 등 각 README의 "의존 방향" 문장을 집계.
3. **계층 요청 흐름**: Adapter → Gateway → Transport → Bootstrap → ContextLoader → AgentRunner → Tools/Skills/Store.
- 모든 README 푸터의 "Part of the Nexora …" 줄이 이 지도를 링크하도록 한다.

### P1 — platform stub 확장 (①)
`cli`/`gateway`/`registry` README를 §6 골격으로 확장. 각 패키지 실제 export 기준:
- `registry`: `InMemoryAgentRegistry`(register/unregister/get/list/findByCapability/findBySubscription).
- `gateway`: GatewayRouter·StreamingGatewayRouter·미들웨어(auth/rate-limit) — `src/{router,streaming-router,middleware}.ts` 확인 후 기술.
- `cli`: 명령 세트(create/dev/doctor/dlq/budget/handraise/export/import) — `src/{cli,dev,ops,scaffold,headless,portability}.ts` 확인 후 기술. CLI는 라이브러리가 아니라 **명령** 중심이므로 레시피는 명령 예시로.

### P1 — 에이전트 진입점 (신규): 루트 `AGENTS.md`
짧은 라우팅 문서. 내용:
- 이 저장소는 Nexora(멀티테넌트 에이전트 프레임워크), 패키지 식별자는 `@dongkseo/*`.
- capability→패키지: `docs/architecture/packages-map.md` 보라.
- 각 패키지 사용법: 해당 `packages/<x>/README.md` / `platform/<x>/README.md`.
- 정확한 타입: 본문 복사 말고 `ctx_read(path, mode=signatures)`.
- README 골격 규약(§6) 한 줄 요약.

### P2 — 골격 일관성 + 템플릿 문서화
- 정본 골격을 `docs/architecture/README-template.md`(또는 동급)로 1장 명문화 → 신규 패키지가 표류하지 않게.
- 리치 17개 README는 골격 준수 **스팟체크**만(이름은 이미 정확). 누락 슬롯만 보강.

## 6. 정본 README 골격 (Canonical skeleton)

`packages/core`·`store`·`transport` README가 따르는 형식을 규약으로 고정:

```
# @dongkseo/<pkg>
**Stability: <stable|advanced|experimental>** · `pnpm add @dongkseo/<pkg>`
> (1줄) 에이전트가 소스 안 열고 쓰게 하는 오리엔테이션 문서. 타입은 signatures로 읽어라.

## 무엇인가 / 무엇이 아닌가      — ✅ 담는 것 / ❌ 안 담는 것 + 의존 방향
## 핵심 개념                     — | 개념 | 무엇 | 대표 export | 표
## 사용 레시피                   — 실제 동작 코드(임포트 포함), 가능하면 예제 경로 참조
## API 표면 (소스 안 열고 타입만) — ctx_read(path, mode=map|signatures) 경로 목록
## 유지보수 (drift 방지)         — README=목적·개념·레시피만; API 정본=소스 TSDoc
## Tests                         — cd <path> && pnpm test
Part of the [Nexora](../../README.md) … · [Package map](../../docs/architecture/packages-map.md)
```

## 7. 검증 (Verification)

- **이름:** 라이브 문서에 `@nexora/` 0건 (`grep -rn '@nexora/'` — plans/·plan/·.git 제외).
- **링크:** 새로/수정된 내부 링크가 실제 파일로 해석됨.
- **레시피 정합:** platform README의 레시피가 참조하는 export가 `src/index.ts`에 실재(`mode=signatures`로 대조).
- **도달성:** `AGENTS.md` → `packages-map.md` → 임의 패키지 README → signatures 경로가 끊김 없이 이어짐.
- **골격:** 17개 README가 §6 섹션 제목을 모두 가짐.

## 8. 리스크 / 열린 점

- `docs/architecture/*.md`의 `@nexora`가 설치 식별자인지 브랜드 서술인지 케이스 혼재 → 일괄 치환 금지, 맥락 판단 필요(구현 단계에서 파일별 확인).
- `docs/project-structure-map.html`(1105줄)은 이번 범위 밖. 새 `packages-map.md`와 중복/표류 가능 → 후속에서 정리 여부 별도 판단(지금은 건드리지 않음).
- mermaid가 GitHub에서 렌더되지만 lean-ctx/에이전트는 텍스트로 읽음 → 그래프 옆에 텍스트 인접목록(adjacency)도 병기.

## 9. 작업 순서 (구현 계획 입력)

1. 사실 수집: platform 3개 `src/index.ts` signatures, 각 패키지 의존 방향 집계.
2. P0 이름 교정(라이브 문서) + 링크 점검.
3. `packages-map.md` 작성(표+그래프+흐름).
4. platform stub 3개 확장(골격).
5. 루트 `AGENTS.md` 작성, README 푸터에 지도 링크 추가.
6. `README-template.md` 명문화 + 리치 17개 스팟체크 보강.
7. 검증(§7) 후 단일 PR/커밋.
