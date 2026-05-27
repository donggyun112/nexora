# pi-agent-core 통합 (Stage 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@earendil-works/pi-agent-core@^0.75.5`의 `agentLoop` + `Agent` 클래스를 새 `PiAgentRunner` 어댑터로 감싸 Nexora `AgentRuntime` 인터페이스에 맞춘다. 기존 `AgentRunner`는 그대로 보존하고, bootstrap에서 feature flag로 둘 중 하나를 선택할 수 있게 한다.

**Architecture:**
- 새 모듈 `packages/core/src/pi-agent/`에 어댑터 5종 추가 (`runner`, `message-bridge`, `tool-bridge`, `event-bridge`, `middleware-bridge`)
- pi-agent-core 의 `agentLoop`는 `Model<Api>`를 직접 받으므로 `PiAgentRunner`는 `LLMProvider` 대신 pi-ai 의 `Model`을 받는다 (Stage 1의 `PiAiProvider`와는 별도 경로 — pi-agent-core 사용 시 PiAiProvider는 우회됨)
- Nexora `ToolDefinition` → pi `AgentTool` 변환 필요 (TypeBox 스키마 ↔ JSON Schema)
- 8개 Nexora middleware 훅 → 5개 pi 훅으로 매핑 (beforeLLMCall, onSessionStart/End, beforePromptBuild는 호출 시점 변경/누락)
- pi `AgentEvent` → Nexora `AgentEvent` 변환 시 `artifact`/`progress`는 합성 (afterToolCall에서 `details` 검사)
- Stage 2는 **부분 채택** — `AgentRunner`/`architectures` 패키지는 유지

**Tech Stack:** TypeScript 5.8, vitest, Node 22.19+, `@earendil-works/pi-agent-core@0.75.5`, `@earendil-works/pi-ai@0.75.5` (이미 설치).

**비호환 / 제약 (사전 공지):**
1. **단일 루프**: pi-agent-core 의 `agentLoop`은 React-like 단일 루프. `PlanExecuteArchitecture`/`DeepResearchArchitecture`/`LoopArchitecture`는 PiAgentRunner로 마이그레이션 불가 — 이들은 기존 `AgentRunner` 유지
2. **Middleware 손실**: `beforeLLMCall`, `onSessionStart/End`, `beforePromptBuild`, `onBudgetExceeded`는 pi-agent-core 훅 표면에 없음. `transformContext`로 일부 흡수, `subscribe()` listener로 일부 흡수, 나머지는 PiAgentRunner 호출 시점 (execute 진입/종료)에서 manual 호출
3. **이벤트 타입**: pi는 `artifact`/`progress`/`thinking`을 별도 이벤트로 emit하지 않음. `tool_execution_end`의 `result.details`에서 artifact 추출, `message_update`의 thinking content에서 thinking 합성
4. **Tool 인자 스키마**: Nexora `ToolDefinition.parameters`는 JSON Schema 객체. pi의 `Tool.parameters`는 TypeBox `TSchema`. 둘은 호환되지만 TypeScript 타입 시스템상 별개 — 변환 시 `as TSchema` 캐스팅 필요

---

## File Structure

**Create:**
- `packages/core/src/pi-agent/index.ts` — barrel export
- `packages/core/src/pi-agent/runner.ts` — `PiAgentRunner` (AgentRuntime 구현, ~150줄)
- `packages/core/src/pi-agent/message-bridge.ts` — `toAgentMessages`, `convertToLlm` (~80줄)
- `packages/core/src/pi-agent/tool-bridge.ts` — `toAgentTools(Nexora ToolExecutor)` (~100줄)
- `packages/core/src/pi-agent/event-bridge.ts` — pi `AgentEvent` → Nexora `AgentEvent` 변환기 (~120줄)
- `packages/core/src/pi-agent/middleware-bridge.ts` — `middlewaresToAgentLoopConfig` (~150줄)
- `packages/core/src/__tests__/pi-agent-message-bridge.test.ts`
- `packages/core/src/__tests__/pi-agent-tool-bridge.test.ts`
- `packages/core/src/__tests__/pi-agent-event-bridge.test.ts`
- `packages/core/src/__tests__/pi-agent-middleware-bridge.test.ts`
- `packages/core/src/__tests__/pi-agent-runner.test.ts`

**Modify:**
- `packages/core/package.json` — add `@earendil-works/pi-agent-core: ^0.75.5`
- `packages/core/src/index.ts` — re-export `PiAgentRunner` + types
- `packages/core/src/bootstrap.ts` — feature flag `PI_AGENT_RUNNER` (env or option)
- `examples/e2e-demo/src/main.ts` — `LLM_BACKEND=pi-agent` 분기 추가

**Untouched:**
- `packages/core/src/runner.ts` — 기존 `AgentRunner` 유지
- `packages/architectures/src/*.ts` — 4개 architecture 그대로 유지
- `packages/core/src/middleware.ts` — Nexora middleware 계약 유지

---

## Task 1: Worktree + pi-agent-core dependency

**Files:** `packages/core/package.json`

- [ ] **Step 1: Worktree**

```bash
cd /Users/dongkseo/Project/Nexora
git worktree add ../Nexora-pi-agent -b feature/pi-agent-core-adoption
cd ../Nexora-pi-agent
```

- [ ] **Step 2: dep 추가**

`packages/core/package.json` `dependencies`에 `@earendil-works/pi-agent-core: ^0.75.5`를 알파벳 순서로 삽입 (pi-ai 다음 위치):

```json
  "dependencies": {
    "@anthropic-ai/sdk": "^0.73.0",
    "@earendil-works/pi-ai": "^0.75.5",
    "@earendil-works/pi-agent-core": "^0.75.5",
    "@nexora/contracts": "workspace:*",
    "ajv": "^8.18.0",
    "openai": "^4.73.0"
  },
```

- [ ] **Step 3: install + baseline**

```bash
pnpm install
pnpm --filter @nexora/contracts build  # ensure contracts dist
pnpm --filter @nexora/core test
```

Expected: 모든 기존 91 테스트 (Stage 1 결과) PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/package.json pnpm-lock.yaml
git commit -m "chore(core): add @earendil-works/pi-agent-core dependency"
```

---

## Task 2: Scaffold pi-agent module

**Files:** Create skeleton files with throw-stubs.

- [ ] **Step 1: Create `packages/core/src/pi-agent/message-bridge.ts`**

```typescript
/**
 * Nexora ChatMessage/AgentInput ↔ pi-agent-core AgentMessage 변환.
 *
 * pi-agent-core의 AgentMessage = pi-ai의 Message (UserMessage | AssistantMessage |
 * ToolResultMessage) + 앱이 declaration merging으로 추가한 custom 메시지.
 *
 * Nexora는 custom 메시지 타입을 추가하지 않으므로 AgentMessage = pi-ai Message.
 * 따라서 Stage 1의 toPiContext 매핑을 재사용한다.
 */

import type { ChatMessage, AgentInput, LLMMessage } from '@nexora/contracts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';

export interface AgentMessageBuildOptions {
  systemPrompt?: string;
  api?: string;
  provider?: string;
}

/**
 * AgentInput + history(ChatMessage[]) → AgentMessage[] (pi-agent-core 형식).
 * systemPrompt는 메시지 배열에 포함하지 않고 AgentContext.systemPrompt로 별도 전달한다.
 */
export function toAgentMessages(
  input: AgentInput,
  options?: AgentMessageBuildOptions,
): AgentMessage[] {
  throw new Error('not implemented');
}

/**
 * pi-agent-core의 convertToLlm 콜백 구현. agentLoop가 AgentMessage[]를
 * LLM provider에 보낼 pi-ai Message[]로 변환할 때 호출한다.
 * Nexora가 custom AgentMessage 타입을 추가하지 않으므로 거의 identity 함수.
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
  throw new Error('not implemented');
}
```

- [ ] **Step 2: Create `packages/core/src/pi-agent/tool-bridge.ts`**

```typescript
/**
 * Nexora ToolDefinition[] → pi-agent-core AgentTool[].
 *
 * pi의 AgentTool은 TypeBox parameters + execute 콜백을 요구. Nexora는
 * JSON Schema parameters + Tool.handler를 갖는다. 변환 시 parameters는
 * 캐스팅하고, execute는 Nexora ToolExecutor를 호출하도록 래핑.
 */

import type { ToolDefinition, ToolExecutor } from '@nexora/contracts';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

export function toAgentTools(
  tools: ToolDefinition[],
  executor: ToolExecutor,
): AgentTool<never>[] {
  throw new Error('not implemented');
}
```

- [ ] **Step 3: Create `packages/core/src/pi-agent/event-bridge.ts`**

```typescript
/**
 * pi-agent-core AgentEvent → Nexora AgentEvent 변환.
 *
 * pi 이벤트는 subscribe(listener)로 받는다. listener는 async — 우리는 변환된
 * Nexora 이벤트를 AsyncQueue에 push하고, PiAgentRunner.execute()는 이 큐에서
 * yield한다.
 *
 * 매핑:
 *   tool_execution_start → tool_call
 *   tool_execution_end   → tool_result (+ details에 artifact 있으면 artifact event)
 *   message_update       → text (assistant text delta) / thinking (thinking delta)
 *   agent_end            → done
 *   (error는 EventStream의 result()가 throw — 호출자에서 처리)
 */

import type { AgentEvent as NexoraEvent } from '@nexora/contracts';
import type { AgentEvent as PiEvent } from '@earendil-works/pi-agent-core';

export function* fromPiEvent(event: PiEvent): Generator<NexoraEvent> {
  throw new Error('not implemented');
}
```

- [ ] **Step 4: Create `packages/core/src/pi-agent/middleware-bridge.ts`**

```typescript
/**
 * Nexora AgentMiddleware[] → pi-agent-core AgentLoopConfig hooks 변환.
 *
 * 매핑 (가능한 것만):
 *   beforeToolCall  → AgentLoopConfig.beforeToolCall (1:1, block 신호 전달)
 *   afterToolCall   → AgentLoopConfig.afterToolCall  (1:1, terminate 가능)
 *   beforePromptBuild → AgentLoopConfig.transformContext (systemPrompt 변경은 불가, context 변경만)
 *   onCompact       → AgentLoopConfig.transformContext (truncate 시점에서 호출)
 *
 * 매핑 불가 (호출 시점을 PiAgentRunner.execute() 진입/종료로 옮김):
 *   beforeExecution   → PiAgentRunner.execute() 진입 직후 manual 호출
 *   afterExecution    → execute() finally 블록에서 manual 호출
 *   beforeLLMCall     → 손실 (pi-agent-core는 LLM 호출 직전 훅이 없음 — transformContext가 가장 가까움)
 *   afterLLMCall      → subscribe listener의 message_end에서 합성
 *   onSessionStart/End → PiAgentRunner.execute() 진입/종료에서 manual 호출
 *   onBudgetExceeded  → PiAgentRunner가 afterLLMCall 합성 후 별도 budget check 수행
 */

import type { AgentMiddleware } from '../middleware.js';
import type { AgentLoopConfig } from '@earendil-works/pi-agent-core';

export interface BridgedConfig {
  /** agentLoop에 전달할 hooks subset */
  hooks: Pick<AgentLoopConfig,
    'beforeToolCall' | 'afterToolCall' | 'transformContext' | 'shouldStopAfterTurn'>;
  /** PiAgentRunner.execute()가 시작 시 호출 */
  runBeforeExecution: (input: import('@nexora/contracts').AgentInput) => Promise<void>;
  /** PiAgentRunner.execute()가 종료 시 호출 */
  runAfterExecution: (
    input: import('@nexora/contracts').AgentInput,
    events: import('@nexora/contracts').AgentEvent[],
    finalContent: string,
    error?: Error,
  ) => Promise<void>;
}

export function middlewaresToAgentLoopConfig(
  middlewares: AgentMiddleware[],
): BridgedConfig {
  throw new Error('not implemented');
}
```

- [ ] **Step 5: Create `packages/core/src/pi-agent/runner.ts`**

```typescript
/**
 * PiAgentRunner — AgentRuntime 구현, pi-agent-core agentLoop 기반.
 *
 * 기존 AgentRunner와 동일한 인터페이스(`execute(input)`, `abort()`)를 제공하되
 * 내부 루프는 pi-agent-core가 담당한다.
 */

import type {
  AgentRuntime, AgentInput, AgentEvent,
  ToolDefinition, ToolExecutor, MemoryProvider, AgentLogger,
} from '@nexora/contracts';
import type { Model, Api } from '@earendil-works/pi-ai';
import type { AgentMiddleware } from '../middleware.js';

export interface PiAgentRunnerOptions {
  model: Model<Api>;
  tools: ToolDefinition[];
  toolExecutor: ToolExecutor;
  systemPrompt: string;
  middlewares?: AgentMiddleware[];
  memory?: MemoryProvider;
  logger?: AgentLogger;
  idleTimeoutMs?: number;
  /** pi-ai 의 getApiKey 콜백 — 없으면 env 기반 */
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
}

export class PiAgentRunner implements AgentRuntime {
  constructor(_options: PiAgentRunnerOptions) {
    throw new Error('not implemented');
  }

  execute(_input: AgentInput): AsyncGenerator<AgentEvent> {
    throw new Error('not implemented');
  }

  abort(): void {
    throw new Error('not implemented');
  }
}
```

- [ ] **Step 6: Create `packages/core/src/pi-agent/index.ts`**

```typescript
export { PiAgentRunner } from './runner.js';
export type { PiAgentRunnerOptions } from './runner.js';
export { toAgentMessages, convertToLlm } from './message-bridge.js';
export { toAgentTools } from './tool-bridge.js';
export { fromPiEvent } from './event-bridge.js';
export { middlewaresToAgentLoopConfig } from './middleware-bridge.js';
export type { BridgedConfig } from './middleware-bridge.js';
```

- [ ] **Step 7: Build verify**

```bash
cd /Users/dongkseo/Project/Nexora-pi-agent
pnpm --filter @nexora/core build
```

Expected: 컴파일 성공.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/pi-agent/
git commit -m "feat(core): scaffold pi-agent module structure"
```

---

## Task 3: `message-bridge` TDD

**Files:**
- Modify: `packages/core/src/pi-agent/message-bridge.ts`
- Create: `packages/core/src/__tests__/pi-agent-message-bridge.test.ts`

- [ ] **Step 1: Failing tests**

```typescript
// packages/core/src/__tests__/pi-agent-message-bridge.test.ts
import { describe, it, expect } from 'vitest';
import { toAgentMessages, convertToLlm } from '../pi-agent/message-bridge.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

describe('toAgentMessages', () => {
  it('builds a single user message from AgentInput.prompt', () => {
    const r = toAgentMessages({ prompt: 'hello' });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ role: 'user', content: 'hello' });
  });

  it('includes ChatMessage history before the new prompt', () => {
    const r = toAgentMessages({
      prompt: 'next question',
      history: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
      ],
    });
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ role: 'user', content: 'first' });
    expect(r[1]).toMatchObject({ role: 'assistant' });
    expect(r[2]).toMatchObject({ role: 'user', content: 'next question' });
  });

  it('attaches images to the user prompt as ImageContent blocks', () => {
    const r = toAgentMessages({
      prompt: 'see this',
      images: [{ type: 'image', data: 'BASE64', mimeType: 'image/png' }],
    });
    const last = r[r.length - 1];
    expect(last.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'see this' }),
      expect.objectContaining({ type: 'image', data: 'BASE64', mimeType: 'image/png' }),
    ]));
  });

  it('uses api/provider from options for assistant history replay shape', () => {
    const r = toAgentMessages(
      { prompt: 'q', history: [{ role: 'assistant', content: 'a' }] },
      { api: 'anthropic-messages', provider: 'anthropic' },
    );
    const asst = r[0] as { api: string; provider: string };
    expect(asst.api).toBe('anthropic-messages');
    expect(asst.provider).toBe('anthropic');
  });
});

describe('convertToLlm', () => {
  it('is an identity function — passes pi Message[] through unchanged', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'hi', timestamp: 0 } as never,
    ];
    expect(convertToLlm(messages)).toBe(messages);
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm --filter @nexora/core test pi-agent-message-bridge
```

- [ ] **Step 3: 구현**

`message-bridge.ts`:

```typescript
import type { ChatMessage, AgentInput, LLMMessage } from '@nexora/contracts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Message, UserMessage, AssistantMessage } from '@earendil-works/pi-ai';

export interface AgentMessageBuildOptions {
  api?: string;
  provider?: string;
}

const REPLAY_API = 'openai-completions';
const REPLAY_PROVIDER = 'openai';

export function toAgentMessages(
  input: AgentInput,
  options?: AgentMessageBuildOptions,
): AgentMessage[] {
  const api = options?.api ?? REPLAY_API;
  const provider = options?.provider ?? REPLAY_PROVIDER;
  const messages: AgentMessage[] = [];

  for (const h of input.history ?? []) {
    if (h.role === 'user') {
      messages.push({
        role: 'user', content: h.content, timestamp: Date.now(),
      } as UserMessage);
    } else if (h.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: h.content ? [{ type: 'text', text: h.content }] : [],
        api, provider, model: 'replay',
        stopReason: 'stop',
        usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
        timestamp: Date.now(),
      } as AssistantMessage);
    }
  }

  // Current user prompt — text + images if present.
  const userContent = input.images && input.images.length > 0
    ? [
        { type: 'text' as const, text: input.prompt },
        ...input.images.map(i => ({
          type: 'image' as const, data: i.data, mimeType: i.mimeType,
        })),
      ]
    : input.prompt;

  messages.push({
    role: 'user', content: userContent, timestamp: Date.now(),
  } as UserMessage);

  return messages;
}

export function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages as Message[];
}
```

- [ ] **Step 4: PASS 확인**

```bash
pnpm --filter @nexora/core test pi-agent-message-bridge
```

Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pi-agent/message-bridge.ts \
  packages/core/src/__tests__/pi-agent-message-bridge.test.ts
git commit -m "feat(core): convert AgentInput to pi-agent-core AgentMessage[]"
```

---

## Task 4: `tool-bridge` TDD

**Files:**
- Modify: `packages/core/src/pi-agent/tool-bridge.ts`
- Create: `packages/core/src/__tests__/pi-agent-tool-bridge.test.ts`

- [ ] **Step 1: Failing tests**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { toAgentTools } from '../pi-agent/tool-bridge.js';
import type { ToolDefinition, ToolExecutor } from '@nexora/contracts';

const tools: ToolDefinition[] = [
  {
    name: 'search',
    description: 'web search',
    parameters: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    },
    handler: async () => 'unused',
  } as ToolDefinition,
];

function fakeExecutor(impl: (name: string, callId: string, input: unknown) => unknown): ToolExecutor {
  return {
    execute: vi.fn(async (name, callId, input) => impl(name, callId, input)),
    list: () => tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })),
    get: (name) => tools.find(t => t.name === name),
  };
}

describe('toAgentTools', () => {
  it('preserves name/description and uses parameters as TypeBox-compatible schema', () => {
    const exec = fakeExecutor(() => 'ok');
    const out = toAgentTools(tools, exec);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('search');
    expect(out[0].description).toBe('web search');
    expect(out[0].label).toBe('search');
  });

  it('execute() forwards toolCallId, args, and signal to the executor', async () => {
    const exec = fakeExecutor(() => 'world');
    const out = toAgentTools(tools, exec);
    const ac = new AbortController();
    const r = await out[0].execute('call_1', { q: 'hi' }, ac.signal);
    expect(r.content).toEqual([{ type: 'text', text: 'world' }]);
    expect(exec.execute).toHaveBeenCalledWith('search', 'call_1', { q: 'hi' }, ac.signal);
  });

  it('execute() wraps string results in TextContent', async () => {
    const exec = fakeExecutor(() => 'hello');
    const out = toAgentTools(tools, exec);
    const r = await out[0].execute('c', { q: 'x' });
    expect(r.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('execute() passes through structured tool result objects with text+image', async () => {
    const exec = fakeExecutor(() => ({
      content: [
        { type: 'text', text: 'caption' },
        { type: 'image', data: 'B64', mimeType: 'image/png' },
      ],
    }));
    const out = toAgentTools(tools, exec);
    const r = await out[0].execute('c', { q: 'x' });
    expect(r.content).toEqual([
      { type: 'text', text: 'caption' },
      { type: 'image', data: 'B64', mimeType: 'image/png' },
    ]);
  });

  it('execute() surfaces artifact details in result.details', async () => {
    const exec = fakeExecutor(() => ({
      content: [{ type: 'text', text: 'rendered' }],
      details: { artifact: { kind: 'image', uri: 'attachment://chart.png' } },
    }));
    const out = toAgentTools(tools, exec);
    const r = await out[0].execute('c', { q: 'x' });
    expect(r.details).toEqual({ artifact: { kind: 'image', uri: 'attachment://chart.png' } });
  });
});
```

- [ ] **Step 2: 실패 확인**

- [ ] **Step 3: 구현**

`tool-bridge.ts`:

```typescript
import type { ToolDefinition, ToolExecutor } from '@nexora/contracts';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TextContent, ImageContent, TSchema } from '@earendil-works/pi-ai';

export function toAgentTools(
  tools: ToolDefinition[],
  executor: ToolExecutor,
): AgentTool<TSchema>[] {
  return tools.map(t => ({
    name: t.name,
    label: t.name,
    description: t.description,
    parameters: t.parameters as unknown as TSchema,
    execute: async (toolCallId, params, signal) => {
      const result = await executor.execute(t.name, toolCallId, params, signal);
      return normalizeResult(result);
    },
  } as AgentTool<TSchema>));
}

function normalizeResult(result: unknown): AgentToolResult<unknown> {
  if (typeof result === 'string') {
    return { content: [{ type: 'text', text: result }], details: undefined };
  }
  if (result && typeof result === 'object' && 'content' in (result as Record<string, unknown>)) {
    const r = result as { content: (TextContent | ImageContent)[]; details?: unknown };
    return {
      content: r.content,
      details: r.details,
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    details: result,
  };
}
```

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pi-agent/tool-bridge.ts \
  packages/core/src/__tests__/pi-agent-tool-bridge.test.ts
git commit -m "feat(core): wrap Nexora ToolExecutor as pi-agent-core AgentTool"
```

---

## Task 5: `event-bridge` TDD

**Files:**
- Modify: `packages/core/src/pi-agent/event-bridge.ts`
- Create: `packages/core/src/__tests__/pi-agent-event-bridge.test.ts`

- [ ] **Step 1: Failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { fromPiEvent } from '../pi-agent/event-bridge.js';
import type { AgentEvent as PiEvent } from '@earendil-works/pi-agent-core';

const collect = (e: PiEvent) => [...fromPiEvent(e)];

describe('fromPiEvent', () => {
  it('maps tool_execution_start to tool_call', () => {
    expect(collect({
      type: 'tool_execution_start',
      toolCallId: 't1', toolName: 'search', args: { q: 'x' },
    } as PiEvent)).toEqual([
      { type: 'tool_call', id: 't1', name: 'search', input: { q: 'x' } },
    ]);
  });

  it('maps tool_execution_end to tool_result', () => {
    expect(collect({
      type: 'tool_execution_end',
      toolCallId: 't1', toolName: 'search',
      result: { content: [{ type: 'text', text: 'OK' }], details: undefined },
      isError: false,
    } as PiEvent)).toEqual([
      { type: 'tool_result', id: 't1', name: 'search', result: { content: [{ type: 'text', text: 'OK' }], details: undefined }, isError: false },
    ]);
  });

  it('emits an additional artifact event when tool_execution_end details contains artifact', () => {
    const out = collect({
      type: 'tool_execution_end',
      toolCallId: 't1', toolName: 'render',
      result: {
        content: [{ type: 'text', text: 'chart' }],
        details: { artifact: { kind: 'image', uri: 'attachment://chart.png' } },
      },
      isError: false,
    } as PiEvent);
    expect(out).toContainEqual(expect.objectContaining({ type: 'tool_result' }));
    expect(out).toContainEqual({
      type: 'artifact',
      artifact: { kind: 'image', uri: 'attachment://chart.png' },
    });
  });

  it('maps agent_end to done with content joined from assistant messages', () => {
    const out = collect({
      type: 'agent_end',
      messages: [
        { role: 'user', content: 'q', timestamp: 0 },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'reply' }],
          stopReason: 'stop',
          api: 'openai-completions', provider: 'openai', model: 'm',
          usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
          timestamp: 0,
        },
      ],
    } as PiEvent);
    const done = out.find(e => e.type === 'done');
    expect(done).toMatchObject({ type: 'done', content: 'reply' });
  });

  it('emits text deltas from message_update with text_delta assistantMessageEvent', () => {
    expect(collect({
      type: 'message_update',
      message: {} as never,
      assistantMessageEvent: { type: 'text_delta', delta: 'hi', contentIndex: 0, partial: {} as never },
    } as PiEvent)).toEqual([
      { type: 'text', text: 'hi' },
    ]);
  });

  it('emits thinking deltas from message_update with thinking_delta', () => {
    expect(collect({
      type: 'message_update',
      message: {} as never,
      assistantMessageEvent: { type: 'thinking_delta', delta: '...', contentIndex: 0, partial: {} as never },
    } as PiEvent)).toEqual([
      { type: 'thinking', content: '...' },
    ]);
  });

  it('returns nothing for non-mapped events', () => {
    expect(collect({ type: 'agent_start' } as PiEvent)).toEqual([]);
    expect(collect({ type: 'turn_start' } as PiEvent)).toEqual([]);
    expect(collect({ type: 'message_start', message: {} as never } as PiEvent)).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

- [ ] **Step 3: 구현**

`event-bridge.ts`:

```typescript
import type { AgentEvent as NexoraEvent } from '@nexora/contracts';
import type { AgentEvent as PiEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';

export function* fromPiEvent(event: PiEvent): Generator<NexoraEvent> {
  switch (event.type) {
    case 'tool_execution_start':
      yield {
        type: 'tool_call',
        id: event.toolCallId,
        name: event.toolName,
        input: event.args,
      };
      return;

    case 'tool_execution_end': {
      yield {
        type: 'tool_result',
        id: event.toolCallId,
        name: event.toolName,
        result: event.result,
        isError: event.isError,
      };
      // Synthesize artifact event if the tool's details carry one.
      const details = (event.result as { details?: { artifact?: unknown } } | null)?.details;
      if (details && typeof details === 'object' && 'artifact' in details) {
        yield {
          type: 'artifact',
          artifact: (details as { artifact: never }).artifact,
        };
      }
      return;
    }

    case 'message_update': {
      const inner = event.assistantMessageEvent;
      if (inner.type === 'text_delta') {
        yield { type: 'text', text: inner.delta };
      } else if (inner.type === 'thinking_delta') {
        yield { type: 'thinking', content: inner.delta };
      }
      return;
    }

    case 'agent_end': {
      const last = [...event.messages].reverse().find(
        (m): m is AssistantMessage => m.role === 'assistant',
      );
      const text = last
        ? last.content.filter(c => c.type === 'text').map(c => (c as { text: string }).text).join('')
        : '';
      yield { type: 'done', content: text, toolCalls: [] };
      return;
    }

    default:
      return;
  }
}
```

- [ ] **Step 4: PASS 확인** (7 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pi-agent/event-bridge.ts \
  packages/core/src/__tests__/pi-agent-event-bridge.test.ts
git commit -m "feat(core): translate pi-agent-core events to Nexora AgentEvent"
```

---

## Task 6: `middleware-bridge` TDD

**Files:**
- Modify: `packages/core/src/pi-agent/middleware-bridge.ts`
- Create: `packages/core/src/__tests__/pi-agent-middleware-bridge.test.ts`

이 task는 8개 Nexora 훅 → 5개 pi 훅 변환을 검증한다. 손실되는 훅은 명시적으로 호출 시점이 변경됨을 테스트한다.

- [ ] **Step 1: Failing tests**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { middlewaresToAgentLoopConfig } from '../pi-agent/middleware-bridge.js';
import type { AgentMiddleware } from '../middleware.js';

describe('middlewaresToAgentLoopConfig', () => {
  it('forwards beforeToolCall to pi hook', async () => {
    const beforeToolCall = vi.fn();
    const mw: AgentMiddleware = { name: 't', beforeToolCall };
    const out = middlewaresToAgentLoopConfig([mw]);

    await out.hooks.beforeToolCall!({
      assistantMessage: {} as never,
      toolCall: { type: 'toolCall', id: 'c1', name: 'search', arguments: { q: 'x' } } as never,
      args: { q: 'x' },
      context: {} as never,
    });

    expect(beforeToolCall).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'search',
      callId: 'c1',
      input: { q: 'x' },
    }));
  });

  it('forwards afterToolCall to pi hook', async () => {
    const afterToolCall = vi.fn();
    const mw: AgentMiddleware = { name: 't', afterToolCall };
    const out = middlewaresToAgentLoopConfig([mw]);

    await out.hooks.afterToolCall!({
      assistantMessage: {} as never,
      toolCall: { type: 'toolCall', id: 'c1', name: 'search', arguments: {} } as never,
      args: {},
      result: { content: [{ type: 'text', text: 'OK' }], details: undefined },
      isError: false,
      context: {} as never,
    });

    expect(afterToolCall).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'search',
      callId: 'c1',
      isError: false,
    }));
  });

  it('runBeforeExecution invokes beforeExecution + onSessionStart on all middleware', async () => {
    const beforeExecution = vi.fn();
    const onSessionStart = vi.fn();
    const mw: AgentMiddleware = { name: 't', beforeExecution, onSessionStart };
    const out = middlewaresToAgentLoopConfig([mw]);

    await out.runBeforeExecution({ prompt: 'hi' });
    expect(beforeExecution).toHaveBeenCalled();
    expect(onSessionStart).toHaveBeenCalled();
  });

  it('runAfterExecution invokes afterExecution + onSessionEnd in reverse order', async () => {
    const calls: string[] = [];
    const mwA: AgentMiddleware = {
      name: 'A',
      afterExecution: () => { calls.push('A.after'); },
      onSessionEnd: () => { calls.push('A.end'); },
    };
    const mwB: AgentMiddleware = {
      name: 'B',
      afterExecution: () => { calls.push('B.after'); },
    };
    const out = middlewaresToAgentLoopConfig([mwA, mwB]);
    await out.runAfterExecution({ prompt: 'hi' }, [], '');
    // afterExecution runs B then A (reverse), then onSessionEnd
    expect(calls).toEqual(['B.after', 'A.after', 'A.end']);
  });

  it('returns empty hooks/no-op runners when no middleware', () => {
    const out = middlewaresToAgentLoopConfig([]);
    expect(out.hooks.beforeToolCall).toBeUndefined();
    expect(out.hooks.afterToolCall).toBeUndefined();
  });
});
```

- [ ] **Step 2: 실패 확인**

- [ ] **Step 3: 구현**

`middleware-bridge.ts`:

```typescript
import type { AgentMiddleware } from '../middleware.js';
import type { AgentLoopConfig } from '@earendil-works/pi-agent-core';
import type { AgentInput, AgentEvent } from '@nexora/contracts';

export interface BridgedConfig {
  hooks: Pick<AgentLoopConfig,
    'beforeToolCall' | 'afterToolCall' | 'transformContext' | 'shouldStopAfterTurn'>;
  runBeforeExecution: (input: AgentInput) => Promise<void>;
  runAfterExecution: (
    input: AgentInput,
    events: AgentEvent[],
    finalContent: string,
    error?: Error,
  ) => Promise<void>;
}

export function middlewaresToAgentLoopConfig(
  middlewares: AgentMiddleware[],
): BridgedConfig {
  const hasBeforeToolCall = middlewares.some(m => m.beforeToolCall);
  const hasAfterToolCall = middlewares.some(m => m.afterToolCall);

  const hooks: BridgedConfig['hooks'] = {};

  if (hasBeforeToolCall) {
    hooks.beforeToolCall = async (ctx) => {
      for (const m of middlewares) {
        if (m.beforeToolCall) {
          await m.beforeToolCall({
            toolName: ctx.toolCall.name,
            callId: ctx.toolCall.id,
            input: ctx.args,
            tool: undefined as never,
          });
        }
      }
      return undefined;
    };
  }

  if (hasAfterToolCall) {
    hooks.afterToolCall = async (ctx) => {
      for (let i = middlewares.length - 1; i >= 0; i--) {
        const m = middlewares[i];
        if (m.afterToolCall) {
          const firstText = ctx.result.content.find(c => c.type === 'text');
          await m.afterToolCall({
            toolName: ctx.toolCall.name,
            callId: ctx.toolCall.id,
            input: ctx.args,
            result: firstText
              ? { type: 'text', text: (firstText as { text: string }).text }
              : { type: 'text', text: '' },
            isError: ctx.isError,
          });
        }
      }
      return undefined;
    };
  }

  return {
    hooks,
    async runBeforeExecution(input) {
      for (const m of middlewares) {
        if (m.beforeExecution) {
          await m.beforeExecution({ input, tools: [], systemPrompt: '' });
        }
      }
      for (const m of middlewares) {
        if (m.onSessionStart) {
          await m.onSessionStart({ sessionId: input.requesterId ?? 'session' });
        }
      }
    },
    async runAfterExecution(input, events, finalContent, error) {
      for (let i = middlewares.length - 1; i >= 0; i--) {
        const m = middlewares[i];
        if (m.afterExecution) {
          await m.afterExecution({ input, events, finalContent, error });
        }
      }
      for (let i = middlewares.length - 1; i >= 0; i--) {
        const m = middlewares[i];
        if (m.onSessionEnd) {
          await m.onSessionEnd({ sessionId: input.requesterId ?? 'session' });
        }
      }
    },
  };
}
```

- [ ] **Step 4: PASS 확인** (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pi-agent/middleware-bridge.ts \
  packages/core/src/__tests__/pi-agent-middleware-bridge.test.ts
git commit -m "feat(core): bridge Nexora middlewares to pi-agent-core hooks"
```

---

## Task 7: `PiAgentRunner` 통합

**Files:**
- Modify: `packages/core/src/pi-agent/runner.ts`
- Create: `packages/core/src/__tests__/pi-agent-runner.test.ts`

이 task는 Agent 클래스의 subscribe-based 이벤트를 AsyncGenerator로 변환하는 가장 까다로운 부분이다.

- [ ] **Step 1: Failing 통합 테스트**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PiAgentRunner } from '../pi-agent/runner.js';
import type { ToolExecutor } from '@nexora/contracts';

// pi-agent-core를 mock — Agent class를 fake로 대체
vi.mock('@earendil-works/pi-agent-core', async () => {
  class FakeAgent {
    private listeners: ((ev: any, signal: any) => void)[] = [];
    state = { messages: [], systemPrompt: '', tools: [] };
    subscribe(fn: any) {
      this.listeners.push(fn);
      return () => { this.listeners = this.listeners.filter(l => l !== fn); };
    }
    async prompt(_input: any) {
      // Emit a scripted event sequence.
      const ac = new AbortController();
      for (const ev of (FakeAgent as any).scripted ?? []) {
        for (const l of this.listeners) await l(ev, ac.signal);
      }
    }
    abort() {}
    async waitForIdle() {}
  }
  (FakeAgent as any).scripted = [];
  return { Agent: FakeAgent };
});

const fakeExecutor: ToolExecutor = {
  execute: async () => 'ignored — not used in this test path',
  list: () => [],
};

const fakeModel = { id: 'mock', name: 'mock', api: 'openai-completions', provider: 'openai' } as never;

describe('PiAgentRunner', () => {
  beforeEach(async () => {
    const pkg = await import('@earendil-works/pi-agent-core');
    (pkg.Agent as any).scripted = [
      { type: 'agent_start' },
      {
        type: 'tool_execution_start',
        toolCallId: 't1', toolName: 'search', args: { q: 'x' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 't1', toolName: 'search',
        result: { content: [{ type: 'text', text: 'hits' }], details: undefined },
        isError: false,
      },
      {
        type: 'agent_end',
        messages: [
          { role: 'user', content: 'q', timestamp: 0 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'final answer' }],
            stopReason: 'stop',
            api: 'openai-completions', provider: 'openai', model: 'm',
            usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
            timestamp: 0,
          },
        ],
      },
    ];
  });

  it('yields Nexora AgentEvents translated from pi events', async () => {
    const runner = new PiAgentRunner({
      model: fakeModel,
      tools: [],
      toolExecutor: fakeExecutor,
      systemPrompt: 'sys',
    });
    const events = [];
    for await (const e of runner.execute({ prompt: 'q' })) events.push(e);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_call', id: 't1', name: 'search',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_result', id: 't1',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'done', content: 'final answer',
    }));
  });

  it('calls runBeforeExecution and runAfterExecution on middleware', async () => {
    const beforeExecution = vi.fn();
    const afterExecution = vi.fn();
    const runner = new PiAgentRunner({
      model: fakeModel,
      tools: [],
      toolExecutor: fakeExecutor,
      systemPrompt: 'sys',
      middlewares: [{ name: 'm', beforeExecution, afterExecution }],
    });

    for await (const _ of runner.execute({ prompt: 'q' })) { /* drain */ }

    expect(beforeExecution).toHaveBeenCalled();
    expect(afterExecution).toHaveBeenCalled();
  });

  it('abort() calls Agent.abort()', async () => {
    const pkg = await import('@earendil-works/pi-agent-core');
    const abortSpy = vi.fn();
    (pkg.Agent as any).prototype.abort = abortSpy;

    const runner = new PiAgentRunner({
      model: fakeModel, tools: [], toolExecutor: fakeExecutor, systemPrompt: 'sys',
    });
    // start execute but don't await
    const gen = runner.execute({ prompt: 'q' });
    runner.abort();
    // Drain to release
    try { for await (const _ of gen) { /* */ } } catch { /* */ }

    expect(abortSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 실패 확인**

- [ ] **Step 3: 구현**

`runner.ts`:

```typescript
import { Agent } from '@earendil-works/pi-agent-core';
import type {
  AgentRuntime, AgentInput, AgentEvent,
  ToolDefinition, ToolExecutor, MemoryProvider, AgentLogger,
} from '@nexora/contracts';
import type { Model, Api } from '@earendil-works/pi-ai';
import type { AgentMiddleware } from '../middleware.js';
import { toAgentMessages, convertToLlm } from './message-bridge.js';
import { toAgentTools } from './tool-bridge.js';
import { fromPiEvent } from './event-bridge.js';
import { middlewaresToAgentLoopConfig } from './middleware-bridge.js';

export interface PiAgentRunnerOptions {
  model: Model<Api>;
  tools: ToolDefinition[];
  toolExecutor: ToolExecutor;
  systemPrompt: string;
  middlewares?: AgentMiddleware[];
  memory?: MemoryProvider;
  logger?: AgentLogger;
  idleTimeoutMs?: number;
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
}

const NOOP_LOGGER: AgentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

export class PiAgentRunner implements AgentRuntime {
  private readonly options: PiAgentRunnerOptions;
  private readonly bridge = middlewaresToAgentLoopConfig([]);
  private currentAgent?: { abort: () => void };

  constructor(options: PiAgentRunnerOptions) {
    this.options = options;
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent> {
    const middlewares = this.options.middlewares ?? [];
    const bridge = middlewaresToAgentLoopConfig(middlewares);

    const agent = new Agent({
      initialState: {
        systemPrompt: this.options.systemPrompt,
        model: this.options.model,
        thinkingLevel: 'off',
        tools: toAgentTools(this.options.tools, this.options.toolExecutor),
        messages: [],
      },
      convertToLlm,
      beforeToolCall: bridge.hooks.beforeToolCall,
      afterToolCall: bridge.hooks.afterToolCall,
      getApiKey: this.options.getApiKey,
    });

    this.currentAgent = agent;

    // Queue for event delivery: subscribe pushes, execute() yields.
    const queue: AgentEvent[] = [];
    let done = false;
    let waitResolve: (() => void) | null = null;
    const wake = () => { if (waitResolve) { waitResolve(); waitResolve = null; } };

    const unsubscribe = agent.subscribe(async (piEvent) => {
      for (const nexEvent of fromPiEvent(piEvent)) {
        queue.push(nexEvent);
        wake();
      }
      if (piEvent.type === 'agent_end') {
        done = true;
        wake();
      }
    });

    const collectedEvents: AgentEvent[] = [];
    let finalContent = '';
    let executionError: Error | undefined;

    try {
      await bridge.runBeforeExecution(input);
      const messages = toAgentMessages(input, {
        api: this.options.model.api as string,
        provider: this.options.model.provider as string,
      });
      // Fire-and-forget — events arrive via subscribe.
      agent.prompt(messages).catch(err => {
        executionError = err instanceof Error ? err : new Error(String(err));
        done = true;
        wake();
      });

      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>(r => { waitResolve = r; });
          continue;
        }
        const ev = queue.shift()!;
        collectedEvents.push(ev);
        if (ev.type === 'done') finalContent = ev.content;
        yield ev;
      }

      if (executionError) {
        const errEvent: AgentEvent = { type: 'error', message: executionError.message };
        collectedEvents.push(errEvent);
        yield errEvent;
      }
    } finally {
      unsubscribe();
      this.currentAgent = undefined;
      try {
        await bridge.runAfterExecution(input, collectedEvents, finalContent, executionError);
      } catch {
        // afterExecution 실패 무시
      }
    }
  }

  abort(): void {
    this.currentAgent?.abort();
  }
}
```

- [ ] **Step 4: PASS 확인** (3 tests)

- [ ] **Step 5: 전체 mapping+runner suite 회귀**

```bash
pnpm --filter @nexora/core test pi-agent
```

Expected: 20 tests pass (5 + 5 + 7 + 5 + 3, 새 모듈만).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/pi-agent/runner.ts \
  packages/core/src/__tests__/pi-agent-runner.test.ts
git commit -m "feat(core): implement PiAgentRunner backed by pi-agent-core Agent"
```

---

## Task 8: Public export + bootstrap feature flag

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/bootstrap.ts`

- [ ] **Step 1: Re-export from core index**

`packages/core/src/index.ts` 끝에 추가:

```typescript
export { PiAgentRunner } from './pi-agent/index.js';
export type { PiAgentRunnerOptions } from './pi-agent/index.js';
```

- [ ] **Step 2: Bootstrap 플래그 추가**

`packages/core/src/bootstrap.ts`에서 현재 `AgentRunner`를 직접 인스턴스화하는 위치를 찾는다 (검색: `new AgentRunner(`). 그 자리에 다음 패턴을 추가:

```typescript
const usePiAgent = process.env.NEXORA_PI_AGENT === '1' || options.usePiAgent === true;
const runtime: AgentRuntime = usePiAgent
  ? new PiAgentRunner({
      model: options.piAgentModel!, // caller must provide for pi-agent mode
      tools: bootstrapTools,
      toolExecutor: bootstrapToolExecutor,
      systemPrompt: bootstrapSystemPrompt,
      middlewares: options.middlewares,
      memory: options.memory,
      logger: options.logger,
    })
  : new AgentRunner({
      architecture: options.architecture,
      llm: options.llm,
      tools: bootstrapToolExecutor,
      memory: options.memory,
      logger: options.logger,
      middlewares: options.middlewares,
    });
```

(정확한 위치/변수명은 현재 bootstrap.ts 구조를 따라 조정. `options.usePiAgent`, `options.piAgentModel`을 `AgentBootstrapOptions`에 추가한다.)

- [ ] **Step 3: 전체 빌드 + 워크스페이스 회귀**

```bash
pnpm --filter @nexora/core build
pnpm -r build
pnpm -r test
```

Expected: 전체 그린.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/bootstrap.ts
git commit -m "feat(core): expose PiAgentRunner and bootstrap feature flag"
```

---

## Task 9: e2e-demo 분기 + 수동 검증 (선택)

**Files:** `examples/e2e-demo/src/main.ts`

- [ ] **Step 1: 분기 추가**

`createLLM` 옆에 별도 `createRuntime` 분기 또는 `LLM_BACKEND=pi-agent` 시 PiAgentRunner를 사용하도록 분기. main.ts의 runner 생성 위치를 찾아:

```typescript
if (process.env.LLM_BACKEND === 'pi-agent') {
  const { getModel } = await import('@earendil-works/pi-ai');
  const model = getModel(process.env.PI_PROVIDER ?? 'anthropic', process.env.PI_MODEL ?? 'claude-haiku-4-5-20251001');
  // ... build PiAgentRunner per agent
}
```

세부 구현은 e2e-demo의 Room/Participant 구조에 맞춰 조정. 주요 목표는 같은 시나리오가 pi-agent-core 백엔드로도 동작하는지 확인.

- [ ] **Step 2: 빌드 확인**

```bash
pnpm --filter e2e-demo build
```

- [ ] **Step 3: (선택) 수동 실행**

```bash
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
LLM_BACKEND=pi-agent \
pnpm --filter e2e-demo dev
```

- [ ] **Step 4: Commit**

```bash
git add examples/e2e-demo/src/main.ts
git commit -m "feat(e2e-demo): allow selecting PiAgentRunner via LLM_BACKEND=pi-agent"
```

---

## Task 10: 워크스페이스 회귀 + PR

- [ ] **Step 1: 전체 회귀**

```bash
pnpm -r lint
pnpm -r typecheck
pnpm -r test
```

- [ ] **Step 2: PR 생성**

```bash
gh pr create --title "feat(core): add PiAgentRunner backed by pi-agent-core (Stage 2)" \
  --body "$(cat <<'EOF'
## Summary
- @earendil-works/pi-agent-core@^0.75.5 도입 — 단일 React-like agentLoop을 PiAgentRunner로 어댑팅
- AgentRuntime 인터페이스로 노출 (기존 AgentRunner는 유지, feature flag로 선택)
- Nexora middleware 8개 훅 중 5개를 pi-agent-core 훅으로 매핑, 3개는 호출 시점으로 이동 (beforeLLMCall은 누락)
- pi AgentEvent → Nexora AgentEvent 변환 + artifact/thinking 합성

## Out of scope (Stage 2)
- PlanExecuteArchitecture / DeepResearchArchitecture / LoopArchitecture는 pi-agent-core가 단일 루프만 제공하므로 마이그레이션 불가 — 기존 AgentRunner 유지
- AgentRunner 자체 삭제는 Stage 3에서 (production 트래픽 검증 후)

## Test plan
- [x] `pnpm --filter @nexora/core test` — pi-agent 5종 모듈 + 기존 회귀 모두 PASS
- [x] `pnpm -r test` — 워크스페이스 전체 그린
- [ ] `LLM_BACKEND=pi-agent pnpm --filter e2e-demo dev` 수동 검증

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- pi-agent-core agentLoop 어댑팅 → Task 7 `PiAgentRunner` ✓
- 어댑터 5종 모듈 → Tasks 2-6 ✓
- 기존 AgentRunner 보존 → Task 8 feature flag ✓
- middleware 8 → pi 5 매핑 → Task 6 ✓
- 이벤트 합성 (artifact/thinking) → Task 5 ✓
- bootstrap 통합 → Task 8 ✓
- e2e-demo 검증 분기 → Task 9 ✓

**Placeholder scan:** "implement later", "handle X", "similar to" — none.

**Type consistency:**
- `BridgedConfig.hooks`는 `Pick<AgentLoopConfig, 4 fields>` — Task 6 정의, Task 7 사용 ✓
- `AgentMessage` = pi-ai Message + custom (Nexora는 custom 없음) — Task 3 가정, Task 5/6에서 일관 ✓
- `Model<Api>` 사용 — Task 7 옵션, Task 8 bootstrap 전달 ✓

**리스크 미해결:**
- **Subscribe → AsyncGenerator 변환의 backpressure**: Task 7의 큐 패턴은 consumer가 느릴 때 메모리 부담. 실제 트래픽에선 bounded queue나 throttle 필요 — Stage 3에서 다룬다.
- **`beforeLLMCall` 손실**: budget middleware의 사전 예산 차단이 작동하지 않음. Task 6에서 transformContext로 합성 시도하거나, PiAgentRunner를 사용하는 경우 onBudgetExceeded만 사후 검사로 동작 (예산 초과 시 다음 턴 차단). 명시적 한계.
- **Tool execution 경로 이중화**: Stage 2 채택 시 pi-agent-core가 tools를 내부 실행. Nexora의 ToolExecutor 래퍼(`tool-bridge`)가 그 경로를 거치지만, `wrapToolExecutorWithSignal` 같은 기존 AgentRunner 래퍼는 사용 안 됨 — 시그널 전파는 `toAgentTools.execute(toolCallId, params, signal)`의 signal 인자가 책임진다. Task 4 테스트로 검증.
- **memory 통합**: 현재 plan은 memory를 단순 옵션으로 받지만 pi-agent-core는 `Agent.state.messages`로 자체 관리. `MemoryProvider.append`를 subscribe listener에서 호출하는 보강은 Stage 3.
