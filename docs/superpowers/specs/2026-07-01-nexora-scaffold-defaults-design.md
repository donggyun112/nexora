# nexora — 스캐폴드 기본값 + Fallback 모델 고정 설계

- 날짜: 2026-07-01
- 대상 레포: `nexora` (`@dongkseo/core`, `@dongkseo/cli`)
- 레퍼런스 소비자: `ixpert_manager`

## 1. 배경 / 문제

`ixpert_manager`는 `@dongkseo/*` 프레임워크 위에 올린 에이전트 매니저로, "nexora 소비의 기본 패키지 형태"를 잘 보여준다. 하지만 그 배터리(HTTP 진입점, LLM+fallback 조립, 샌드박스/워크스페이스, 승인 게이트, transcript 영속, 도구 조립, `context/` 구조)를 **전부 손으로** 짰다 — `src/runtime/compose.ts`(345L) + `src/main.ts` + `context/`.

한편 nexora의 빠른 개발용 진입점인 `@dongkseo/cli`의 `nexora create agent <name>` scaffold는 지금 **골격만** 만든다:

- `agent.config.ts` — `defineAgent(...)` AgentCard
- `index.ts` — `start<Name>(options)` — transport·contextLoader·llm·tools를 **호출자가 전부 주입해야** 하는 bare bootstrap
- `persona.md`, `README.md`

즉 새 프로젝트를 시작하면 개발자는 여전히 compose 전체를 맨손으로 재작성해야 한다. "빠른 개발"이 되지 않는다.

## 2. 설계 원칙 — 프레임워크 성격 vs 정책

핵심 판단 기준: **프레임워크 패키지에는 "정책을 주입받는 범용 메커니즘"만 올린다.** 조직/프로젝트 정책(모델 카탈로그, host 기본값, env 이름, 도구별 인증 방식, fallback 전략)은 프레임워크에 박지 않는다.

이 기준으로 `ixpert_manager`의 인프라 코드를 재판단하면, 승격 후보처럼 보였던 대부분이 실제로는 **정책/글루**였다:

| 코드 | 판정 | 이유 |
|---|---|---|
| `resolve-llm-model.ts` 일가 | 정책 | `in7CredentialedModelIds()`, `CODEX_FALLBACK_MODEL_PREFERENCE`, cross-provider 우선 = 전략/카탈로그 |
| `buildLlm()` 배선 | 조립 정책 | env 이름·`rateLimitRetryMs`·카탈로그 주입. 진짜 메커니즘(`FallbackLLMProvider`)은 이미 nexora에 있음 |
| `git-credentials.ts` | 도구-특정 정책 | `GIT_CONFIG_*` 트릭은 git 전용. 일반 "샌드박스에 시크릿 주입"은 이미 `envAllowList`가 담당 |
| `utils/retry.ts` | 범용 plumbing | 소비자 통합 HTTP 클라이언트용. nexora provider는 429/auth 재시도 내장 |
| `resource-lock.ts` | 이미 있음 | `@dongkseo/core` `KeyedSerializer` |
| `tools/todo.tool.ts` | 이미 있음 | `@dongkseo/tools` builtin `createTodoTool` |
| `tools/skill.tool.ts` | 이미 있음 | `@dongkseo/tools` builtin `createSkillManageTool` |

**결론**: 프레임워크 패키지에 새로 추가할 "프레임워크 성격"은 딱 하나(§3). 나머지 정책/글루는 프레임워크에 박는 대신 **scaffold가 새 프로젝트에 편집 가능한 기본 코드로 생성한다**(§4). 그래서 프레임워크는 얇게 유지되고, 새 프로젝트는 batteries-included로 시작한다.

## 3. 산출물 A — `FallbackLLMProvider` per-entry 모델 고정 (`@dongkseo/core`)

### 문제

`PiAiProvider.stream(messages, options)`은 `options.model`이 오면 그 모델을 우선한다(`packages/core/src/llm/pi-ai/provider.ts:111` `resolveModel(options?.model)`). 그런데 `FallbackLLMProvider`는 caller의 `options`를 각 entry에 **그대로 통과**시킨다(`packages/core/src/llm/fallback.ts:37` `entry.provider.stream(messages, options)`).

`createReactArchitecture({ model })`는 매 호출 `options.model`에 primary 모델을 실어 보낸다. 따라서 fallback이 **다른 provider entry**로 넘어가면 그 entry가 primary의 모델명을 받아 "이 provider가 서빙하지 않는 모델" 오류가 난다. `ixpert_manager`는 각 entry를 `FixedModelLlmProvider`로 감싸 이 결함을 우회하고 있었다 — 즉 **`FallbackLLMProvider`의 결함**이다.

### 변경

`FallbackProviderEntry`에 선택 필드 `model?: string`을 추가한다.

```ts
// packages/core/src/llm/fallback.ts
export interface FallbackProviderEntry {
  name: string;
  provider: LLMProvider;
  /** 설정 시, 이 entry로 가는 모든 호출의 options.model을 이 값으로 고정한다.
   *  미설정 시 caller의 options를 그대로 통과(하위호환). */
  model?: string;
}
```

`stream`/`complete` dispatch에서 entry별로 options를 좁힌다:

```ts
const entryOptions = entry.model ? { ...options, model: entry.model } : options;
// stream:   entry.provider.stream(messages, entryOptions)
// complete: entry.provider.complete(messages, entryOptions)
```

### 성질

- 순수 메커니즘, 정책 0, 도구-특정성 0 → 프레임워크 성격 충족.
- **하위호환**: `model` 미설정 시 기존 동작과 동일.
- 효과: 소비자의 `FixedModelLlmProvider` 래퍼가 불필요해진다.

### 테스트

- entry에 `model` 설정 시, 그 provider가 caller의 `options.model`과 무관하게 자기 모델로 호출됨(stream + complete 각각).
- `model` 미설정 시 caller의 `options`가 변형 없이 전달됨(회귀 방지).
- primary 실패 → fallback entry가 **자기** 모델로 성공하는 경로.

## 4. 산출물 B — scaffold 배터리 기본값 (`@dongkseo/cli`)

### 목표

`nexora create` scaffold가 `ixpert_manager` 수준의 배터리를 갖춘 시작점을 생성한다. 개발자는 생성물을 편집만 하면 되고, compose를 맨손으로 재작성하지 않는다.

### 생성 형태 (열린 결정 — §6-1)

권장: 기존 `create agent`(agents/{name}/ 모듈 골격)는 유지하고, **배터리 포함 standalone 앱 템플릿**을 별도 모드로 추가한다(가칭 `nexora create app <name>`). `ixpert_manager`가 standalone 프로젝트(자체 `package.json`/`src/`/`context/`)이므로, "그 수준"은 모듈 골격이 아니라 앱 템플릿이다.

### 생성물 (앱 템플릿)

1. **`src/main.ts`** — HTTP 진입점: `HttpAdapter` + `GatewayRouter` + `LocalTransport`, `bootstrapAgent`, `toAgentInput`(prompt/images/files/history 정규화), graceful shutdown.
2. **`src/runtime/compose.ts`** — 부수효과 없는 컴포지션 루트:
   - **LLM**: 기본 provider(anthropic) + 모델 기본값, `FallbackLLMProvider` 체인(각 entry에 `model` 세팅 — §3 반영, 래퍼 없음), `ThinkingLlmProvider` 래핑, `RotatingKeyProvider`로 OAuth 토큰 회전.
   - 샌드박스/워크스페이스 provider(`createSandboxProvider` + `ContinuousWorkspaceProvider`, 미지원 시 `HostWorkspaceProvider` 폴백).
   - 승인 게이트(`createApprovalGateMiddleware`, 기본 `block` fail-safe).
   - transcript/memory 영속(`TranscriptStoreJson` + `TranscriptMemoryProvider`, convId 자동 배선).
   - 도구 조립(`assembleToolsWithPolicy` + builtins: read/grep/write/edit/exec/todo/skill_manage).
   - `KeyedSerializer` 공유 인스턴스(리소스 락).
3. **`context/`** — `system.md`, `personas/`, `channels/`, `rules/`, `knowledge/` 뼈대.
4. **정책 shim 템플릿**(편집 대상으로 명시, 프레임워크가 아니라 **생성된 소비자 코드**):
   - LLM 모델/카탈로그/fallback 선호 = env + 상수로 노출.
   - **git 인증**: `envAllowList` seam 위의 얇은 shim으로 생성. `GIT_CONFIG_*` credential-helper 예시를 주석과 함께 소비자 파일로 찍어낸다(프레임워크 패키지에 넣지 않음).
   - auth 토큰 처리: `resolveAnthropicApiKey`/`resolveCodexApiKey`(이미 `@dongkseo/adapters` 제공)를 사용하는 배선.
5. **`package.json`/`tsconfig.json`/`.env.example`** — 의존성·스크립트(build/start/dev)·env 키 목록.

### 성질

- 프레임워크 패키지는 불변(§3 외 변경 없음). scaffold는 **템플릿 문자열만** 추가/교체.
- 생성된 정책 코드는 소비자 소유 → 자유롭게 편집.

### 테스트

- scaffold 실행 → 생성 파일 집합 스냅샷.
- 생성된 앱이 `tsc` 통과(타입 레벨).
- 생성된 `compose.ts`가 `FallbackProviderEntry.model`을 사용(래퍼 없음)하는지 스냅샷 검증.

## 5. 비목표 (Non-goals)

- `resolve-llm-model.ts`, `buildLlm()` 배선, `retry.ts`, git 인증 트릭을 **프레임워크 패키지로 승격하지 않는다**. 이들은 scaffold 템플릿(생성된 소비자 코드)으로만 존재한다.
- 범용 credential/secret 주입 시스템을 새로 만들지 않는다 — `envAllowList`가 이미 그 seam이다(YAGNI).
- `ixpert_manager` 자체 마이그레이션은 이 스펙의 필수 범위가 아니다(§6-2 참고, 선택).

## 6. 열린 결정 (사용자 검토 대상)

1. **생성 형태**: (a) 기존 `create agent`에 배터리 옵션 플래그(예: `--full`) 추가 vs (b) 신규 `create app` 모드 분리. — 권장 (b).
2. **`ixpert_manager` 마이그레이션 포함 여부**: 이번에 소비자도 정리(§7)할지, 스펙은 nexora 산출물 A/B에만 한정할지.
3. **git 인증 shim 배치**: 생성된 `src/runtime/`에 별도 파일 vs `compose.ts` 인라인.

## 7. (선택) `ixpert_manager` 후속 정리

산출물 A/B가 서면, 소비자는 다음을 정리할 수 있다(별도 태스크 가능):

- `FixedModelLlmProvider`(+test) 삭제 → `FallbackProviderEntry.model` 사용.
- `resource-lock.ts` 삭제 → `KeyedSerializer` 채택.
- `tools/todo.tool.ts`, `tools/skill.tool.ts`(`createSkillManageTool`) 삭제 → builtin 채택. `_compat.ts` 제거.
  - 검증 필요: builtin `createSkillManageTool(options)`가 `.pi/skills` 런타임 dir을 지원하는지, builtin `createTodoTool(store)` store 주입 형태가 현 사용처와 1:1인지.

## 8. 검증 전략 요약

- `@dongkseo/core`: fallback 모델 고정 유닛 테스트(§3).
- `@dongkseo/cli`: scaffold 생성물 스냅샷 + 생성 앱 `tsc` 통과(§4).
- 회귀: 기존 `create agent` 골격 스냅샷 불변(신규 모드일 경우).
