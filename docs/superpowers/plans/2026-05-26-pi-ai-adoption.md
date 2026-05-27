# pi-ai 통합 (Stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nexora 의 LLM provider 레이어(`@nexora/core/llm/{anthropic,openai,codex}.ts`)를 `@earendil-works/pi-ai` 단일 어댑터로 대체해, 16+ 프로바이더·OAuth·prompt cache·thinking budget 운영 부담을 외부화한다.

**Architecture:** `LLMProvider` 계약(`packages/contracts/src/agent.ts`)은 그대로 두고, 그 뒤에 `PiAiProvider` 한 클래스를 추가한다. 이 클래스는 Nexora `LLMMessage`/`LLMOptions` ↔ pi-ai `Message`/`Context`/options 매핑만 담당한다. 기존 `AnthropicProvider`/`OpenAIProvider`/`CodexProvider`는 deprecated로 표시하되 1단계에선 삭제하지 않는다 — Stage 2(agent-loop 교체) 검증 이후 일괄 제거. `FallbackLLMProvider`는 계약상 LLMProvider만 알고 있으므로 무수정 통과.

**Tech Stack:** TypeScript 5.8, vitest, Node 22.19+ (현재 26.0.0 OK), pi-ai@0.75.5 (`@earendil-works/pi-ai`).

---

## File Structure

**Create:**
- `packages/core/src/llm/pi-ai/mapping.ts` — Nexora ↔ pi-ai 메시지/옵션 변환 (순수 함수)
- `packages/core/src/llm/pi-ai/provider.ts` — `PiAiProvider` 클래스 (LLMProvider 구현)
- `packages/core/src/llm/pi-ai/index.ts` — barrel export
- `packages/core/src/__tests__/pi-ai-mapping.test.ts` — 매핑 단위 테스트
- `packages/core/src/__tests__/pi-ai-provider.test.ts` — provider 통합 테스트 (faux 모델)

**Modify:**
- `packages/core/package.json` — add `@earendil-works/pi-ai: ^0.75.5`
- `packages/core/src/llm/index.ts` — re-export pi-ai 어댑터
- `packages/core/src/llm/{anthropic,openai,codex}.ts` — 파일 상단에 `@deprecated` JSDoc 한 줄 추가 (코드 변경 없음)
- `examples/e2e-demo/src/main.ts` — pi-ai 사용 분기 시연 (선택, Task 8에서)

**Untouched:**
- `packages/core/src/llm/fallback.ts` — LLMProvider 계약 위에서 동작하므로 변경 불필요
- `packages/contracts/src/agent.ts` — `LLMProvider`/`LLMMessage`/`LLMOptions` 계약 유지

---

## Task 1: Worktree + dependency 설치

**Files:**
- Modify: `packages/core/package.json`

- [ ] **Step 1: Worktree 분기**

```bash
cd /Users/dongkseo/Project/Nexora
git worktree add ../Nexora-pi-ai -b feature/pi-ai-adoption
cd ../Nexora-pi-ai
```

- [ ] **Step 2: pi-ai 의존성 추가**

`packages/core/package.json`의 `dependencies` 블록을 다음으로 교체:

```json
  "dependencies": {
    "@anthropic-ai/sdk": "^0.73.0",
    "@earendil-works/pi-ai": "^0.75.5",
    "@nexora/contracts": "workspace:*",
    "ajv": "^8.18.0",
    "openai": "^4.73.0"
  },
```

(기존 anthropic/openai SDK는 deprecated 어댑터가 아직 import하고 있어 1단계에선 남겨둔다.)

- [ ] **Step 3: 설치 및 기존 테스트 baseline**

```bash
pnpm install
pnpm --filter @nexora/core test
```

Expected: 모든 기존 테스트 PASS (baseline 기록).

- [ ] **Step 4: Commit**

```bash
git add packages/core/package.json pnpm-lock.yaml
git commit -m "chore(core): add @earendil-works/pi-ai dependency"
```

---

## Task 2: 매핑 모듈 — 시그니처 정의 + 빈 함수 (RED phase 준비)

**Files:**
- Create: `packages/core/src/llm/pi-ai/mapping.ts`

- [ ] **Step 1: 파일 골격 작성**

```typescript
/**
 * Nexora ↔ pi-ai 메시지/옵션 변환.
 *
 * Nexora LLMMessage(role: 'system'|'user'|'assistant'|'tool_result',
 *                   content: string | LLMContentBlock[])
 *   ↔ pi-ai Context { systemPrompt?, messages: Message[], tools? }
 *
 * pi-ai Message는 UserMessage | AssistantMessage | ToolResultMessage.
 * toolResult 는 별도 메시지로 분리되며 toolCallId / toolName / isError / timestamp 필수.
 * Assistant 히스토리 replay 시 api/provider/model/usage/stopReason/timestamp 는 placeholder 로 채운다.
 */

import type {
  LLMMessage,
  LLMOptions,
  LLMChunk,
  LLMResponse,
} from '@nexora/contracts';
import type {
  Message,
  AssistantMessage,
  AssistantMessageEvent,
} from '@earendil-works/pi-ai';

export interface MappedContext {
  systemPrompt: string | undefined;
  messages: Message[];
}

export function toPiContext(messages: LLMMessage[], options?: LLMOptions): MappedContext {
  throw new Error('not implemented');
}

export function toPiOptions(options: LLMOptions | undefined): {
  signal?: AbortSignal;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
  maxTokens?: number;
  temperature?: number;
  tools?: { name: string; description: string; parameters: unknown }[];
} {
  throw new Error('not implemented');
}

export function fromPiChunk(
  event: AssistantMessageEvent,
  state: { toolNames: Map<string, string> },
): LLMChunk | undefined {
  throw new Error('not implemented');
}

export function fromPiAssistantMessage(msg: AssistantMessage): LLMResponse {
  throw new Error('not implemented');
}
```

- [ ] **Step 2: 컴파일 통과 확인**

```bash
pnpm --filter @nexora/core build
```

Expected: 컴파일 성공 (함수가 throw할 뿐 시그니처는 맞다).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/llm/pi-ai/mapping.ts
git commit -m "feat(core): scaffold pi-ai mapping module"
```

---

## Task 3: `toPiContext` TDD — system + user + assistant 메시지 변환

**Files:**
- Create: `packages/core/src/__tests__/pi-ai-mapping.test.ts`
- Modify: `packages/core/src/llm/pi-ai/mapping.ts`

- [ ] **Step 1: Failing test 작성**

```typescript
// packages/core/src/__tests__/pi-ai-mapping.test.ts
import { describe, it, expect } from 'vitest';
import { toPiContext } from '../llm/pi-ai/mapping.js';

describe('toPiContext', () => {
  it('extracts system message from messages array into systemPrompt', () => {
    const result = toPiContext([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ]);
    expect(result.systemPrompt).toBe('You are helpful.');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    });
  });

  it('uses options.systemPrompt when no system message in messages', () => {
    const result = toPiContext(
      [{ role: 'user', content: 'hi' }],
      { systemPrompt: 'from options' },
    );
    expect(result.systemPrompt).toBe('from options');
  });

  it('options.systemPrompt is overridden by inline system message', () => {
    const result = toPiContext(
      [
        { role: 'system', content: 'inline' },
        { role: 'user', content: 'hi' },
      ],
      { systemPrompt: 'from options' },
    );
    expect(result.systemPrompt).toBe('inline');
  });

  it('converts string user/assistant content to text ContentBlock array', () => {
    const result = toPiContext([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi back' },
    ]);
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(result.messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi back' }],
    });
  });

  it('converts assistant tool_call blocks to pi-ai toolCall blocks', () => {
    const result = toPiContext([
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          { type: 'tool_call', id: 'call_1', name: 'search', arguments: { q: 'x' } },
        ],
      },
    ]);
    expect(result.messages[1]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling' },
        { type: 'toolCall', id: 'call_1', name: 'search', arguments: { q: 'x' } },
      ],
    });
  });

  it('converts tool_result message into pi-ai toolResult message', () => {
    const result = toPiContext([
      {
        role: 'tool_result',
        content: [
          { type: 'tool_result', id: 'call_1', content: 'OK', isError: false },
        ],
      },
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: 'OK' }],
      isError: false,
    });
  });

  it('converts user image content block', () => {
    const result = toPiContext([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see this' },
          { type: 'image', data: 'BASE64DATA', mimeType: 'image/png' },
        ],
      },
    ]);
    expect(result.messages[0].content).toEqual([
      { type: 'text', text: 'see this' },
      { type: 'image', data: 'BASE64DATA', mimeType: 'image/png' },
    ]);
  });

  it('splits a single tool_result message with multiple results into one toolResult per id', () => {
    const result = toPiContext([
      {
        role: 'tool_result',
        content: [
          { type: 'tool_result', id: 'a', content: 'A out', isError: false },
          { type: 'tool_result', id: 'b', content: 'B err', isError: true },
        ],
      },
    ]);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({ role: 'toolResult', toolCallId: 'a', isError: false });
    expect(result.messages[1]).toMatchObject({ role: 'toolResult', toolCallId: 'b', isError: true });
  });
});
```

- [ ] **Step 2: 실행해서 모두 실패하는지 확인**

```bash
pnpm --filter @nexora/core test pi-ai-mapping
```

Expected: 8 FAIL with "not implemented".

- [ ] **Step 3: `toPiContext` 구현**

`packages/core/src/llm/pi-ai/mapping.ts`의 `toPiContext`를 다음으로 교체. 필요 import는 파일 상단에서 `LLMContentBlock` 을 추가하고, pi-ai 콘텐츠 타입은 인라인 타입 별칭으로 정의한다 (`ContentBlock` 단일 export 가 없음).

```typescript
import type { LLMContentBlock } from '@nexora/contracts';
import type {
  TextContent,
  ImageContent,
  ThinkingContent,
  ToolCall,
  UserMessage,
  ToolResultMessage,
} from '@earendil-works/pi-ai';

type UserContent = string | (TextContent | ImageContent)[];
type AssistantContent = (TextContent | ThinkingContent | ToolCall)[];

export function toPiContext(messages: LLMMessage[], options?: LLMOptions): MappedContext {
  let systemPrompt = options?.systemPrompt;
  const piMessages: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt = typeof msg.content === 'string'
        ? msg.content
        : extractText(msg.content);
      continue;
    }

    if (msg.role === 'user') {
      piMessages.push({
        role: 'user',
        content: toPiUserContent(msg.content),
        timestamp: Date.now(),
      } satisfies UserMessage);
      continue;
    }

    if (msg.role === 'assistant') {
      // History replay: AssistantMessage requires api/provider/model/usage/stopReason/timestamp.
      // pi-ai stores these for round-tripping; for replayed history we provide sentinels.
      piMessages.push({
        role: 'assistant',
        content: toPiAssistantContent(msg.content),
        api: 'openai-completions',
        provider: 'openai',
        model: 'replay',
        stopReason: 'stop',
        usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
        timestamp: Date.now(),
      } as AssistantMessage);
      continue;
    }

    if (msg.role === 'tool_result') {
      if (typeof msg.content === 'string') continue;
      for (const block of msg.content) {
        if (block.type !== 'tool_result') continue;
        piMessages.push({
          role: 'toolResult',
          toolCallId: block.id,
          toolName: '',
          content: [{ type: 'text', text: block.content }],
          isError: block.isError ?? false,
          timestamp: Date.now(),
        } satisfies ToolResultMessage);
      }
    }
  }

  return { systemPrompt, messages: piMessages };
}

function toPiUserContent(content: string | LLMContentBlock[]): UserContent {
  if (typeof content === 'string') return content;
  const blocks: (TextContent | ImageContent)[] = [];
  for (const b of content) {
    if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
    else if (b.type === 'image') blocks.push({ type: 'image', data: b.data, mimeType: b.mimeType });
  }
  return blocks;
}

function toPiAssistantContent(content: string | LLMContentBlock[]): AssistantContent {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const blocks: (TextContent | ThinkingContent | ToolCall)[] = [];
  for (const b of content) {
    if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_call') {
      blocks.push({
        type: 'toolCall',
        id: b.id,
        name: b.name,
        arguments: (b.arguments ?? {}) as Record<string, unknown>,
      });
    }
  }
  return blocks;
}

function extractText(blocks: LLMContentBlock[]): string {
  return blocks.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
}
```

**테스트 영향:** Step 1 의 `'converts string user/assistant content to text ContentBlock array'` 케이스는 user 메시지에서 `content`가 문자열 그대로 보존되도록 기대를 수정한다 — pi-ai 의 `UserMessage.content` 는 `string | (TextContent|ImageContent)[]` 둘 다 허용한다. 이 테스트의 첫 `expect`를 다음으로 교체:

```typescript
expect(result.messages[0]).toMatchObject({
  role: 'user',
  content: 'hello',  // pi-ai는 user 메시지의 string content를 그대로 받는다
});
```

다른 user 케이스(image 포함)는 배열 형태로 유지된다.

- [ ] **Step 4: 테스트 PASS 확인**

```bash
pnpm --filter @nexora/core test pi-ai-mapping
```

Expected: 8 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/pi-ai/mapping.ts packages/core/src/__tests__/pi-ai-mapping.test.ts
git commit -m "feat(core): map Nexora LLMMessage to pi-ai Context"
```

---

## Task 4: `toPiOptions` + `fromPiAssistantMessage` TDD

**Files:**
- Modify: `packages/core/src/__tests__/pi-ai-mapping.test.ts`
- Modify: `packages/core/src/llm/pi-ai/mapping.ts`

- [ ] **Step 1: Failing tests 추가**

`pi-ai-mapping.test.ts` 끝에 추가:

```typescript
import { toPiOptions, fromPiAssistantMessage } from '../llm/pi-ai/mapping.js';
import type { AssistantMessage } from '@earendil-works/pi-ai';

describe('toPiOptions', () => {
  it('maps thinkingLevel to reasoning, dropping "off"', () => {
    expect(toPiOptions({ thinkingLevel: 'high' }).reasoning).toBe('high');
    expect(toPiOptions({ thinkingLevel: 'off' }).reasoning).toBeUndefined();
    expect(toPiOptions(undefined).reasoning).toBeUndefined();
  });

  it('forwards signal, maxTokens, temperature', () => {
    const ac = new AbortController();
    const r = toPiOptions({ signal: ac.signal, maxTokens: 100, temperature: 0.4 });
    expect(r.signal).toBe(ac.signal);
    expect(r.maxTokens).toBe(100);
    expect(r.temperature).toBe(0.4);
  });

  it('forwards tool definitions verbatim', () => {
    const tools = [{ name: 'x', description: 'd', parameters: { type: 'object' } }];
    expect(toPiOptions({ tools }).tools).toEqual(tools);
  });
});

describe('fromPiAssistantMessage', () => {
  const baseMsg = (over: Partial<AssistantMessage>): AssistantMessage => ({
    role: 'assistant',
    content: [],
    stopReason: 'stop',
    usage: { input: 10, output: 5, cost: { input: 0, output: 0, total: 0 } },
    ...over,
  } as AssistantMessage);

  it('extracts text content', () => {
    const r = fromPiAssistantMessage(baseMsg({
      content: [{ type: 'text', text: 'hello' }],
    }));
    expect(r.content).toBe('hello');
    expect(r.stopReason).toBe('end_turn');
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5, cachedTokens: 0 });
  });

  it('extracts tool calls', () => {
    const r = fromPiAssistantMessage(baseMsg({
      content: [
        { type: 'text', text: 'using tool' },
        { type: 'toolCall', id: 'c1', name: 'search', arguments: { q: 'x' } },
      ],
      stopReason: 'toolUse',
    }));
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'search', arguments: { q: 'x' } }]);
    expect(r.stopReason).toBe('tool_use');
  });

  it('reports cacheRead usage when available', () => {
    const r = fromPiAssistantMessage(baseMsg({
      usage: {
        input: 10, output: 5,
        cost: { input: 0, output: 0, cacheRead: 100, total: 0 },
      },
    } as Partial<AssistantMessage>));
    expect(r.usage?.cachedTokens).toBe(100);
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm --filter @nexora/core test pi-ai-mapping
```

Expected: 새 케이스 FAIL.

- [ ] **Step 3: 구현 교체**

`mapping.ts`의 두 함수를 다음으로 교체:

```typescript
export function toPiOptions(options: LLMOptions | undefined): {
  signal?: AbortSignal;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
  maxTokens?: number;
  temperature?: number;
  tools?: { name: string; description: string; parameters: unknown }[];
} {
  if (!options) return {};
  const out: ReturnType<typeof toPiOptions> = {};
  if (options.signal) out.signal = options.signal;
  if (options.maxTokens !== undefined) out.maxTokens = options.maxTokens;
  if (options.temperature !== undefined) out.temperature = options.temperature;
  if (options.tools) out.tools = options.tools;
  if (options.thinkingLevel && options.thinkingLevel !== 'off') {
    out.reasoning = options.thinkingLevel as 'minimal' | 'low' | 'medium' | 'high';
  }
  return out;
}

export function fromPiAssistantMessage(msg: AssistantMessage): LLMResponse {
  const textParts: string[] = [];
  const toolCalls: { id: string; name: string; arguments: unknown }[] = [];

  for (const block of msg.content) {
    if (block.type === 'text') textParts.push(block.text);
    else if (block.type === 'toolCall') {
      toolCalls.push({ id: block.id, name: block.name, arguments: block.arguments });
    }
  }

  const usage: LLMUsage | undefined = msg.usage
    ? {
        promptTokens: msg.usage.input,
        completionTokens: msg.usage.output,
        cachedTokens: (msg.usage.cost as { cacheRead?: number } | undefined)?.cacheRead ?? 0,
      }
    : undefined;

  return {
    content: textParts.join(''),
    model: '',
    stopReason: piToStopReason(msg.stopReason),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
  };
}

function piToStopReason(reason: string): string {
  if (reason === 'toolUse') return 'tool_use';
  if (reason === 'stop') return 'end_turn';
  if (reason === 'aborted') return 'aborted';
  return reason;
}
```

- [ ] **Step 4: 테스트 PASS 확인**

```bash
pnpm --filter @nexora/core test pi-ai-mapping
```

Expected: 모두 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/pi-ai/mapping.ts packages/core/src/__tests__/pi-ai-mapping.test.ts
git commit -m "feat(core): map LLMOptions and AssistantMessage for pi-ai"
```

---

## Task 5: `fromPiChunk` TDD — stream event 매핑

**Files:**
- Modify: `packages/core/src/__tests__/pi-ai-mapping.test.ts`
- Modify: `packages/core/src/llm/pi-ai/mapping.ts`

- [ ] **Step 1: Failing tests 추가**

```typescript
import { fromPiChunk } from '../llm/pi-ai/mapping.js';
import type { StreamEvent } from '@earendil-works/pi-ai';

describe('fromPiChunk', () => {
  const newState = () => ({ toolNames: new Map<string, string>() });

  it('maps text_delta to text_delta', () => {
    const r = fromPiChunk(
      { type: 'text_delta', delta: 'hi', contentIndex: 0 } as StreamEvent,
      newState(),
    );
    expect(r).toEqual({ type: 'text_delta', delta: 'hi' });
  });

  it('maps thinking_delta to thinking_delta', () => {
    const r = fromPiChunk(
      { type: 'thinking_delta', delta: '...', contentIndex: 0 } as StreamEvent,
      newState(),
    );
    expect(r).toEqual({ type: 'thinking_delta', delta: '...' });
  });

  it('maps toolcall_start to tool_call_start and remembers name', () => {
    const state = newState();
    const r = fromPiChunk(
      { type: 'toolcall_start', contentIndex: 0, partial: { id: 't1', name: 'search', arguments: {} } } as StreamEvent,
      state,
    );
    expect(r).toEqual({ type: 'tool_call_start', id: 't1', name: 'search' });
    expect(state.toolNames.get('t1')).toBe('search');
  });

  it('maps toolcall_delta to tool_call_delta with id from state', () => {
    const state = newState();
    state.toolNames.set('t1', 'search');
    const r = fromPiChunk(
      { type: 'toolcall_delta', delta: '{"q":', contentIndex: 0, partial: { id: 't1' } } as StreamEvent,
      state,
    );
    expect(r).toEqual({ type: 'tool_call_delta', id: 't1', delta: '{"q":' });
  });

  it('maps done event to done chunk', () => {
    const r = fromPiChunk(
      { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'final' }], stopReason: 'stop', usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } } } } as StreamEvent,
      newState(),
    );
    expect(r).toEqual({ type: 'done', content: 'final', stopReason: 'end_turn' });
  });

  it('returns undefined for events that have no Nexora equivalent', () => {
    expect(fromPiChunk({ type: 'start' } as StreamEvent, newState())).toBeUndefined();
    expect(fromPiChunk({ type: 'text_start', contentIndex: 0 } as StreamEvent, newState())).toBeUndefined();
    expect(fromPiChunk({ type: 'text_end', contentIndex: 0 } as StreamEvent, newState())).toBeUndefined();
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm --filter @nexora/core test pi-ai-mapping
```

Expected: 6 새 케이스 FAIL.

- [ ] **Step 3: 구현 교체**

```typescript
export function fromPiChunk(
  event: StreamEvent,
  state: { toolNames: Map<string, string> },
): LLMChunk | undefined {
  switch (event.type) {
    case 'text_delta':
      return { type: 'text_delta', delta: event.delta };
    case 'thinking_delta':
      return { type: 'thinking_delta', delta: event.delta };
    case 'toolcall_start': {
      const partial = event.partial as { id: string; name: string };
      state.toolNames.set(partial.id, partial.name);
      return { type: 'tool_call_start', id: partial.id, name: partial.name };
    }
    case 'toolcall_delta': {
      const partial = event.partial as { id: string };
      return { type: 'tool_call_delta', id: partial.id, delta: event.delta };
    }
    case 'done': {
      const msg = event.message;
      const text = msg.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
      return { type: 'done', content: text, stopReason: piToStopReason(msg.stopReason) };
    }
    default:
      return undefined;
  }
}
```

(`piToStopReason`은 Task 4에서 이미 정의됨.)

- [ ] **Step 4: 테스트 PASS 확인**

```bash
pnpm --filter @nexora/core test pi-ai-mapping
```

Expected: 전체 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/pi-ai/mapping.ts packages/core/src/__tests__/pi-ai-mapping.test.ts
git commit -m "feat(core): map pi-ai stream events to Nexora LLMChunk"
```

---

## Task 6: `PiAiProvider` 클래스 + 통합 테스트

**Files:**
- Create: `packages/core/src/llm/pi-ai/provider.ts`
- Create: `packages/core/src/llm/pi-ai/index.ts`
- Create: `packages/core/src/__tests__/pi-ai-provider.test.ts`

- [ ] **Step 1: Failing 통합 테스트 작성**

```typescript
// packages/core/src/__tests__/pi-ai-provider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PiAiProvider } from '../llm/pi-ai/provider.js';

// pi-ai의 stream/complete은 실제 모델 호출이라 mock한다.
vi.mock('@earendil-works/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai')>();
  return {
    ...actual,
    stream: vi.fn(),
    complete: vi.fn(),
    getModel: vi.fn(() => ({
      id: 'mock',
      name: 'mock',
      api: 'openai-completions',
      provider: 'openai',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 1000,
    })),
  };
});

import * as piAi from '@earendil-works/pi-ai';

describe('PiAiProvider.complete', () => {
  beforeEach(() => { vi.mocked(piAi.complete).mockReset(); });

  it('returns content and tool calls from pi-ai assistant message', async () => {
    vi.mocked(piAi.complete).mockResolvedValueOnce({
      role: 'assistant',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'toolCall', id: 'c1', name: 'search', arguments: { q: 'x' } },
      ],
      stopReason: 'toolUse',
      usage: { input: 20, output: 5, cost: { input: 0, output: 0, total: 0 } },
    } as never);

    const p = new PiAiProvider({ provider: 'openai', model: 'gpt-4o-mini' });
    const r = await p.complete([{ role: 'user', content: 'hi' }]);
    expect(r.content).toBe('hello');
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'search', arguments: { q: 'x' } }]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage?.promptTokens).toBe(20);
  });

  it('propagates AbortSignal to pi-ai', async () => {
    const ac = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(piAi.complete).mockImplementationOnce((_m, _c, opts) => {
      capturedSignal = (opts as { signal?: AbortSignal })?.signal;
      return Promise.resolve({
        role: 'assistant', content: [{ type: 'text', text: '' }], stopReason: 'stop',
        usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
      } as never);
    });

    const p = new PiAiProvider({ provider: 'openai', model: 'gpt-4o-mini' });
    await p.complete([{ role: 'user', content: 'hi' }], { signal: ac.signal });
    expect(capturedSignal).toBe(ac.signal);
  });
});

describe('PiAiProvider.stream', () => {
  beforeEach(() => { vi.mocked(piAi.stream).mockReset(); });

  it('yields text_delta and done chunks', async () => {
    async function* fakeEvents() {
      yield { type: 'start' };
      yield { type: 'text_start', contentIndex: 0 };
      yield { type: 'text_delta', delta: 'hi', contentIndex: 0 };
      yield { type: 'text_end', contentIndex: 0 };
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          stopReason: 'stop',
          usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
        },
      };
    }
    vi.mocked(piAi.stream).mockReturnValueOnce(fakeEvents() as never);

    const p = new PiAiProvider({ provider: 'openai', model: 'gpt-4o-mini' });
    const chunks = [];
    for await (const c of p.stream([{ role: 'user', content: 'hi' }])) chunks.push(c);

    expect(chunks).toContainEqual({ type: 'text_delta', delta: 'hi' });
    expect(chunks.at(-1)).toEqual({ type: 'done', content: 'hi', stopReason: 'end_turn' });
  });
});
```

- [ ] **Step 2: 실행해서 FAIL 확인**

```bash
pnpm --filter @nexora/core test pi-ai-provider
```

Expected: 3 FAIL — module not found / class not exported.

- [ ] **Step 3: `PiAiProvider` 구현**

```typescript
// packages/core/src/llm/pi-ai/provider.ts
import { stream as piStream, complete as piComplete, getModel } from '@earendil-works/pi-ai';
import type {
  LLMProvider, LLMMessage, LLMOptions, LLMChunk, LLMResponse,
} from '@nexora/contracts';
import {
  toPiContext, toPiOptions, fromPiChunk, fromPiAssistantMessage,
} from './mapping.js';

export interface PiAiProviderOptions {
  /** pi-ai provider id (예: 'openai', 'anthropic', 'google', 'github-copilot') */
  provider: string;
  /** pi-ai model id (예: 'gpt-4o-mini', 'claude-sonnet-4-20250514') */
  model: string;
  /** Override env-based API key */
  apiKey?: string;
  /** Anthropic 등 prompt-cache 지원 모델용 sessionId */
  sessionId?: string;
  /** 'short' | 'long' | 'none' */
  cacheRetention?: 'short' | 'long' | 'none';
}

export class PiAiProvider implements LLMProvider {
  private readonly model: ReturnType<typeof getModel>;
  private readonly modelId: string;
  private readonly apiKey?: string;
  private readonly sessionId?: string;
  private readonly cacheRetention?: 'short' | 'long' | 'none';

  constructor(options: PiAiProviderOptions) {
    this.model = getModel(options.provider, options.model);
    this.modelId = options.model;
    this.apiKey = options.apiKey;
    this.sessionId = options.sessionId;
    this.cacheRetention = options.cacheRetention;
  }

  private buildOpts(options?: LLMOptions): Record<string, unknown> {
    const opts: Record<string, unknown> = {
      ...toPiOptions(options),
    };
    if (this.apiKey) opts.apiKey = this.apiKey;
    if (this.sessionId) opts.sessionId = this.sessionId;
    if (this.cacheRetention) opts.cacheRetention = this.cacheRetention;
    return opts;
  }

  async *stream(messages: LLMMessage[], options?: LLMOptions): AsyncGenerator<LLMChunk> {
    const ctx = {
      ...toPiContext(messages, options),
      tools: options?.tools as never,
    };
    const state = { toolNames: new Map<string, string>() };
    const events = piStream(this.model, ctx as never, this.buildOpts(options) as never);
    for await (const event of events) {
      const chunk = fromPiChunk(event, state);
      if (chunk) yield chunk;
    }
  }

  async complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const ctx = {
      ...toPiContext(messages, options),
      tools: options?.tools as never,
    };
    const result = await piComplete(this.model, ctx as never, this.buildOpts(options) as never);
    const mapped = fromPiAssistantMessage(result);
    return { ...mapped, model: this.modelId };
  }
}
```

```typescript
// packages/core/src/llm/pi-ai/index.ts
export { PiAiProvider } from './provider.js';
export type { PiAiProviderOptions } from './provider.js';
export { toPiContext, toPiOptions, fromPiChunk, fromPiAssistantMessage } from './mapping.js';
```

- [ ] **Step 4: 테스트 PASS 확인**

```bash
pnpm --filter @nexora/core test pi-ai-provider
```

Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/pi-ai/
git add packages/core/src/__tests__/pi-ai-provider.test.ts
git commit -m "feat(core): add PiAiProvider implementing LLMProvider via pi-ai"
```

---

## Task 7: FallbackLLMProvider 와 `PiAiProvider` 통합 회귀 테스트

**Files:**
- Create: `packages/core/src/__tests__/pi-ai-fallback.test.ts`

- [ ] **Step 1: 회귀 테스트 작성**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { FallbackLLMProvider } from '../llm/fallback.js';
import { PiAiProvider } from '../llm/pi-ai/provider.js';

vi.mock('@earendil-works/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai')>();
  return {
    ...actual,
    stream: vi.fn(),
    complete: vi.fn(),
    getModel: vi.fn(() => ({
      id: 'mock', name: 'mock', api: 'openai-completions', provider: 'openai',
      reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000, maxTokens: 1000,
    })),
  };
});

import * as piAi from '@earendil-works/pi-ai';

describe('FallbackLLMProvider + PiAiProvider', () => {
  it('falls back to second pi-ai provider on first failure', async () => {
    vi.mocked(piAi.complete)
      .mockRejectedValueOnce(new Error('rate limit'))
      .mockResolvedValueOnce({
        role: 'assistant', content: [{ type: 'text', text: 'rescued' }], stopReason: 'stop',
        usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
      } as never);

    const primary = new PiAiProvider({ provider: 'openai', model: 'gpt-4o' });
    const secondary = new PiAiProvider({ provider: 'openai', model: 'gpt-4o-mini' });

    const fallback = new FallbackLLMProvider({
      providers: [
        { name: 'primary', provider: primary },
        { name: 'secondary', provider: secondary },
      ],
      rateLimitRetryMs: 0,
    });

    const r = await fallback.complete([{ role: 'user', content: 'hi' }]);
    expect(r.content).toBe('rescued');
  });
});
```

- [ ] **Step 2: 실행**

```bash
pnpm --filter @nexora/core test pi-ai-fallback
```

Expected: PASS.

- [ ] **Step 3: 전체 테스트 회귀 확인**

```bash
pnpm --filter @nexora/core test
```

Expected: 신/구 테스트 전부 PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/__tests__/pi-ai-fallback.test.ts
git commit -m "test(core): verify FallbackLLMProvider works with PiAiProvider"
```

---

## Task 8: Public export + 기존 provider deprecation 표기

**Files:**
- Modify: `packages/core/src/llm/index.ts`
- Modify: `packages/core/src/llm/anthropic.ts`
- Modify: `packages/core/src/llm/openai.ts`
- Modify: `packages/core/src/llm/codex.ts`

- [ ] **Step 1: `packages/core/src/llm/index.ts` 갱신**

기존 export 블록 아래 추가:

```typescript
export { PiAiProvider } from './pi-ai/index.js';
export type { PiAiProviderOptions } from './pi-ai/index.js';
```

- [ ] **Step 2: 기존 3개 provider 파일에 deprecation 표기**

`anthropic.ts`의 `export class AnthropicProvider` 직전에 JSDoc 한 줄 추가:

```typescript
/** @deprecated Stage-2 진입 시 제거 예정. 신규 코드는 `PiAiProvider`를 사용한다. */
export class AnthropicProvider implements LLMProvider {
```

`openai.ts`의 `export class OpenAIProvider` 직전:

```typescript
/** @deprecated Stage-2 진입 시 제거 예정. 신규 코드는 `PiAiProvider`를 사용한다. */
export class OpenAIProvider implements LLMProvider {
```

`codex.ts`의 `export class CodexProvider` 직전:

```typescript
/** @deprecated Stage-2 진입 시 제거 예정. 신규 코드는 `PiAiProvider({ provider: 'openai-codex', ... })`를 사용한다. */
export class CodexProvider implements LLMProvider {
```

- [ ] **Step 3: 빌드 + 전체 테스트 + 워크스페이스 빌드**

```bash
pnpm --filter @nexora/core build
pnpm -r build
pnpm -r test
```

Expected: 모두 통과 (deprecation 경고는 lint에서만 보인다 — 빌드/테스트 영향 없음).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/llm/
git commit -m "feat(core): export PiAiProvider and mark legacy providers deprecated"
```

---

## Task 9: e2e-demo 예제 — pi-ai 분기 추가

**Files:**
- Modify: `examples/e2e-demo/src/main.ts`

- [ ] **Step 1: 현재 분기 구조 파악**

`examples/e2e-demo/src/main.ts:170-200` 부근에 `createLLM` 함수가 있다. 그 안의 분기 마지막에 다음 케이스 추가:

```typescript
if (process.env.LLM_BACKEND === 'pi-ai') {
  return new PiAiProvider({
    provider: process.env.PI_PROVIDER ?? 'anthropic',
    model: process.env.PI_MODEL ?? 'claude-sonnet-4-20250514',
  });
}
```

그리고 파일 상단 import에 `PiAiProvider` 추가:

```typescript
import { PiAiProvider } from '@nexora/core';
```

- [ ] **Step 2: 수동 동작 확인 (선택, 키가 있을 때만)**

```bash
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
LLM_BACKEND=pi-ai \
pnpm --filter e2e-demo dev
```

Expected: 에이전트 응답 정상 출력. (실패 시 환경변수 누락이나 모델 ID 오타가 가장 흔한 원인.)

- [ ] **Step 3: Commit**

```bash
git add examples/e2e-demo/src/main.ts
git commit -m "feat(e2e-demo): allow selecting PiAiProvider via LLM_BACKEND env"
```

---

## Task 10: 통합 PR 준비

- [ ] **Step 1: 전체 회귀**

```bash
pnpm -r lint
pnpm -r typecheck
pnpm -r test
```

Expected: 전부 통과. 실패 시 해당 패키지 단위로 좁혀 디버그.

- [ ] **Step 2: PR 생성**

```bash
gh pr create --title "feat(core): adopt @earendil-works/pi-ai as primary LLM backend (Stage 1)" \
  --body "$(cat <<'EOF'
## Summary
- @earendil-works/pi-ai@^0.75.5 를 도입해 LLM provider 레이어를 단일 어댑터(`PiAiProvider`)로 통일.
- 16+ 프로바이더·OAuth·prompt cache·thinking budget·token usage 처리를 pi-ai 로 위임.
- 기존 `AnthropicProvider`/`OpenAIProvider`/`CodexProvider`는 deprecated 표기만 추가 — Stage 2 에서 제거.
- `FallbackLLMProvider` 는 변경 없음 (LLMProvider 계약 위에서 그대로 동작).

## Test plan
- [ ] `pnpm --filter @nexora/core test` — mapping/provider/fallback 신규 테스트 PASS
- [ ] `pnpm -r test` — 워크스페이스 전체 회귀 PASS
- [ ] `LLM_BACKEND=pi-ai pnpm --filter e2e-demo dev` 수동 실행 (Anthropic/OpenAI/Codex 각각)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- 16+ provider · OAuth · prompt cache · thinking budget 외부화 → Task 6 `PiAiProvider`가 pi-ai `stream`/`complete`/`getModel`로 위임 ✓
- LLMProvider 계약 무변경 → Task 6 `implements LLMProvider`, `packages/contracts` 미수정 ✓
- 기존 providers 1단계에선 보존 → Task 8 deprecated JSDoc 추가, 코드 삭제 없음 ✓
- FallbackLLMProvider 무수정 통과 → Task 7 회귀 테스트 ✓
- 메시지/옵션/스트림/응답 4가지 매핑 → Task 3·4·5 분리 ✓

**Placeholder scan:** "implement later"/"handle X"/"similar to" 등 없음. 모든 코드 블록은 그대로 붙여넣어 실행 가능한 형태.

**Type consistency:**
- `toPiContext` 반환 `MappedContext { systemPrompt, messages }` ↔ Task 6 `PiAiProvider`에서 `{...toPiContext(...), tools}` 로 spread ✓
- `fromPiAssistantMessage` 반환에 `model: ''` 비워두고 Task 6 에서 `modelId` 주입 ✓
- `fromPiChunk` 두 번째 인자 `state: { toolNames: Map<string, string> }` — Task 5 테스트와 Task 6 stream 루프 모두 동일 시그니처 ✓
- `piToStopReason` Task 4 에서 정의 → Task 5 에서 재사용 (외부 export 불요)
- `LLMUsage.cachedTokens` — Task 4 매핑, `cacheRead` 누락 시 0으로 폴백 ✓

**리스크 미해결:**
- pi-ai 의 `Message` 타입은 assistant 메시지에 `stopReason`/`usage` 를 요구하는데, 히스토리 replay 시 우리가 만드는 메시지에는 그런 정보가 없을 수 있다. Task 3 의 `as Message` 캐스팅으로 우회했으며, 실제 호출 시 pi-ai 가 거부하면 매핑에 sentinel 값(`stopReason: 'stop'`, `usage: { input:0, output:0, cost:{...} }`)을 채워주는 보완이 필요. **Task 6 통합 테스트가 실패하면 이 보완을 먼저 한다.**
- `cacheRetention`/`sessionId`는 모델이 지원할 때만 의미가 있음 — `PiAiProvider` 인자로 받지만 미지원 모델에서는 pi-ai가 무시한다고 README 명시.
