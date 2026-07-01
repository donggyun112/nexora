# Fallback Per-Entry Model Pinning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `FallbackLLMProvider`의 각 entry가 자기 모델을 강제하도록 `FallbackProviderEntry.model?`을 추가해, fallback이 다른 provider로 넘어가도 primary의 모델명이 전달돼 깨지는 결함을 없앤다.

**Architecture:** `FallbackProviderEntry`에 선택 필드 `model?: string`을 추가하고, `stream`/`complete`의 provider 호출 직전에 entry별로 `options.model`을 그 값으로 좁힌다. 미설정 entry는 caller options를 그대로 통과시켜 하위호환을 유지한다.

**Tech Stack:** TypeScript (ESM), vitest. 패키지 `@dongkseo/core`.

## Global Constraints

- 모든 코드는 TypeScript ESM. import는 `.js` 확장자 사용(레포 규약).
- 테스트 러너: `vitest run` (패키지 루트 `pnpm test`).
- 커밋 메시지에 AI/도구 서명·co-author 라인 금지.
- 하위호환 필수: `model` 미설정 시 기존 동작과 바이트 동일해야 함.

---

### Task 1: `FallbackProviderEntry.model` per-entry 모델 고정

**Files:**
- Modify: `packages/core/src/llm/fallback.ts` (interface `FallbackProviderEntry` L21-26; `stream` dispatch ~L145; `complete` dispatch ~L233)
- Test: `packages/core/src/__tests__/llm-fallback.test.ts` (테스트 3개 추가)

**Interfaces:**
- Consumes: `MockLLMProvider`(`./mock-llm.js`) — `callLog[i].options`로 각 provider에 전달된 옵션을 검사. `stream`/`complete` 모두 호출 시 `{ messages, options }`를 `callLog`에 push함.
- Produces: `FallbackProviderEntry { name: string; provider: LLMProvider; model?: string }`. `model` 설정 시 해당 entry의 provider 호출에 `options.model`이 그 값으로 고정됨.

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/core/src/__tests__/llm-fallback.test.ts`의 `describe('FallbackLLMProvider', () => { ... })` 블록 안(기존 테스트들 뒤)에 아래 3개를 추가한다:

```ts
  it('pins each entry to its own model, overriding the caller-supplied model', async () => {
    const primary = new MockLLMProvider([{ text: '', throwError: 'boom' }]);
    const secondary = new MockLLMProvider([{ text: 'ok' }]);

    const fallback = new FallbackLLMProvider({
      providers: [
        { name: 'primary', provider: primary, model: 'primary-model' },
        { name: 'secondary', provider: secondary, model: 'secondary-model' },
      ],
    });

    const result = await fallback.complete(
      [{ role: 'user', content: 'hi' }],
      { model: 'caller-model' },
    );

    expect(result.content).toBe('ok');
    expect(primary.callLog[0].options?.model).toBe('primary-model');
    expect(secondary.callLog[0].options?.model).toBe('secondary-model');
  });

  it('passes caller options through unchanged when entry has no model', async () => {
    const primary = new MockLLMProvider([{ text: 'ok' }]);

    const fallback = new FallbackLLMProvider({
      providers: [{ name: 'primary', provider: primary }],
    });

    await fallback.complete([{ role: 'user', content: 'hi' }], { model: 'caller-model' });

    expect(primary.callLog[0].options?.model).toBe('caller-model');
  });

  it('pins the entry model in stream() too', async () => {
    const primary = new MockLLMProvider([{ text: 'streamed' }]);

    const fallback = new FallbackLLMProvider({
      providers: [{ name: 'primary', provider: primary, model: 'primary-model' }],
    });

    const chunks: string[] = [];
    for await (const c of fallback.stream(
      [{ role: 'user', content: 'hi' }],
      { model: 'caller-model' },
    )) {
      if (c.type === 'text_delta') chunks.push(c.delta);
    }

    expect(chunks.join('')).toBe('streamed');
    expect(primary.callLog[0].options?.model).toBe('primary-model');
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd packages/core && pnpm test -- llm-fallback`
Expected: FAIL — 신규 3개 중 최소 2개 실패. `model` 필드가 `FallbackProviderEntry`에 없어 TS 컴파일 에러("Object literal may only specify known properties, and 'model' does not exist in type 'FallbackProviderEntry'")가 나거나, 통과하더라도 `primary.callLog[0].options?.model`이 `'caller-model'`이라 pin 단언이 실패한다.

- [ ] **Step 3: 인터페이스에 `model?` 추가**

`packages/core/src/llm/fallback.ts`의 `FallbackProviderEntry`를 교체한다:

```ts
export interface FallbackProviderEntry {
  /** 사용자 표시용 이름 */
  name: string;
  /** 실제 provider */
  provider: LLMProvider;
  /**
   * 설정 시, 이 entry로 가는 모든 호출의 options.model을 이 값으로 고정한다
   * (caller가 넘긴 options.model 무시). fallback이 다른 provider로 넘어가도
   * 각 provider가 자기 모델로 호출되도록 보장한다.
   * 미설정 시 caller의 options를 그대로 통과(하위호환).
   */
  model?: string;
}
```

- [ ] **Step 4: `stream()` dispatch에서 entry 모델 고정**

`stream()` 안에서 `const isLast = i === this.entries.length - 1;` 다음 줄, `let receivedAny = false;` 앞에 entryOptions를 계산하고, provider 호출을 그 값으로 바꾼다:

```ts
      const entry = this.entries[i];
      const isLast = i === this.entries.length - 1;
      // entry.model 설정 시 이 entry 호출의 model을 고정(caller options.model 무시).
      const entryOptions = entry.model ? { ...options, model: entry.model } : options;
```

그리고 같은 블록의 stream 호출을 교체한다:

```ts
        for await (const chunk of entry.provider.stream(messages, entryOptions)) {
```

(신호 검사 `options?.signal?.aborted`는 그대로 `options`를 쓴다 — signal은 동일 객체이므로 변경 불필요.)

- [ ] **Step 5: `complete()` dispatch에서 entry 모델 고정**

`complete()` 안에서 `const isLast = i === this.entries.length - 1;` 다음, `try {` 앞에 동일하게 추가하고 complete 호출을 교체한다:

```ts
      const entry = this.entries[i];
      const isLast = i === this.entries.length - 1;
      const entryOptions = entry.model ? { ...options, model: entry.model } : options;

      try {
        const response = await entry.provider.complete(messages, entryOptions);
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `cd packages/core && pnpm test -- llm-fallback`
Expected: PASS — 신규 3개 포함 `FallbackLLMProvider` 전체 통과.

- [ ] **Step 7: 코어 전체 테스트 + 타입 체크**

Run: `cd packages/core && pnpm test && pnpm lint`
Expected: PASS — 회귀 없음(`model` 미설정 경로가 기존 테스트를 그대로 통과).

- [ ] **Step 8: 커밋**

```bash
git add packages/core/src/llm/fallback.ts packages/core/src/__tests__/llm-fallback.test.ts
git commit -m "feat(core): pin per-entry model in FallbackLLMProvider

FallbackProviderEntry.model을 추가해 각 fallback entry가 자기 모델로
호출되도록 강제한다. 미설정 시 caller options 그대로 통과(하위호환).
소비자가 FixedModelLlmProvider 래퍼 없이 cross-provider fallback을
구성할 수 있게 한다."
```

---

## Self-Review

- **Spec coverage(§3):** 산출물 A의 인터페이스 변경·dispatch 변경·하위호환·테스트(entry pin / passthrough / stream+complete) 모두 Task 1에 매핑됨. ✓
- **Placeholder scan:** 모든 스텝에 실제 코드/명령/기대 출력 존재. ✓
- **Type consistency:** `FallbackProviderEntry.model?: string`, `entryOptions` 이름이 stream/complete/테스트에서 일치. `MockLLMProvider.callLog[i].options?.model` 접근은 mock 구현(`callLog.push({ messages, options })`)과 일치. ✓

---

## Deliverable B (별도 플랜)

산출물 B(`@dongkseo/cli` scaffold를 ixpert_manager 수준 배터리 기본값으로 — 신규 `create app` 모드)는 `platform/cli` 소속의 독립 서브시스템이며, `ixpert_manager`의 `main.ts`/`compose.ts`/`context/`를 정책-주입형 템플릿으로 포팅하는 대규모 템플릿 저작 작업이다. writing-plans의 scope-check에 따라 별도 플랜 파일로 분리한다:
`docs/superpowers/plans/2026-07-01-cli-scaffold-app-template.md` (후속 작성).

핵심 태스크 윤곽(각 태스크 = ixpert_manager 소스 1개 → scaffold render 함수 1개, 정책 파라미터화):
1. `scaffoldApp(options)` 골격 + `create app <name>` CLI dispatch + 생성 파일 스냅샷 테스트.
2. `renderMain` — HTTP 진입점(adapter+gateway+bootstrap).
3. `renderCompose` — LLM(fallback 체인, entry.model 사용) + 샌드박스/워크스페이스 + 승인 게이트 + transcript 영속 + 도구 조립.
4. `renderContext*` — `system.md`/personas/channels/rules 뼈대.
5. git-cred 정책 shim + `package.json`/`tsconfig`/`.env.example`.
6. 생성 앱 `tsc` 통과 검증.
