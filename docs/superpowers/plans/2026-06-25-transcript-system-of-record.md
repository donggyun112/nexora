# Transcript System-of-Record Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `TranscriptStore` the single system of record for conversation history — capture tool_use/tool_result/images during execution and replay them as rich `LLMMessage`s on the next turn, fully replacing the text-only `ConversationStore` memory path.

**Architecture:** A pure `LLMMessage ↔ TranscriptEntry` mapping layer (core); a `TranscriptMemoryProvider` that replays transcript entries as rich history; a runtime `TranscriptRecorder` that is the single writer, fed by the harness from inbound input, the `AgentEvent` stream, and steers; contract widening so `MemoryProvider`/`AgentInput.history` carry `LLMMessage`. The store + JSONL schema already exist (`TranscriptStoreJson`) and need no changes beyond being surfaced through the store factory.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node, Vitest, pnpm workspaces (`@dongkseo/*`).

## Global Constraints

- ESM imports MUST use `.js` extension on relative paths (e.g. `from './mapping.js'`).
- No AI/Claude attribution in commit messages.
- Dependency direction is fixed: `architectures → contracts (types only)`, `core → contracts`. `core` and `architectures` MUST NOT import each other. Shared pure helpers over contract types live in `@dongkseo/contracts`.
- Backend descriptor unchanged: `TranscriptStoreJson.describeBackend()` = `{ name:'json-file', type:'dev', durable:true, multiProcess:false }`.
- Greenfield: do NOT write a migration for `conversations/*.jsonl`. The text path is being removed.
- Every task ends green (typecheck + its tests pass) and is committed.

---

## File Structure

**Create:**
- `packages/contracts/src/llm-message.ts` — pure helpers over `LLMMessage`/`LLMContentBlock` (`imageResultForLLM`, `sanitizeToolPairsInPlace`) relocated here so both `core` and `architectures` share one copy.
- `packages/core/src/transcript-mapping.ts` — pure `LLMMessage ↔ ContentBlock` conversion + async replay assembly.
- `packages/core/src/transcript-memory.ts` — `TranscriptMemoryProvider`.
- `packages/core/src/transcript-recorder.ts` — `TranscriptRecorder` (single writer).
- Test files alongside each (`packages/**/__tests__/*.test.ts`).

**Modify:**
- `packages/contracts/src/agent.ts` — widen `MemoryProvider`, `AgentInput.history`.
- `packages/contracts/src/index.ts` — export `llm-message.ts` helpers.
- `packages/architectures/src/loop-helpers.ts` — re-export relocated helpers; consume rich `getHistory`; drop `memory.append`.
- `packages/architectures/src/react.ts`, `plan-execute.ts` — rich history wiring.
- `packages/store/src/factory.ts` — add `transcript` to `StoreProvider`.
- `packages/store-json/src/index.ts` — add `transcript` to `JsonStoreProvider`.
- `packages/core/src/execution-harness.ts` — build + drive the recorder; update `NullMemory`.
- `packages/core/src/index.ts` — export new modules; remove `CoreMemoryProvider`.
- Delete `packages/core/src/memory.ts` (`CoreMemoryProvider`, text-only) — superseded.

---

## Task 1: Relocate pure LLM-message helpers to contracts

**Files:**
- Create: `packages/contracts/src/llm-message.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/architectures/src/loop-helpers.ts:63-75` and `:363-368` (replace bodies with re-exports)
- Test: `packages/contracts/src/__tests__/llm-message.test.ts`

**Interfaces:**
- Produces: `imageResultForLLM(result: unknown): Extract<LLMContentBlock,{type:'image'}> | null`; `sanitizeToolPairsInPlace(history: LLMMessage[]): void`

- [ ] **Step 1: Write the failing test**

```ts
// packages/contracts/src/__tests__/llm-message.test.ts
import { describe, it, expect } from 'vitest';
import type { LLMMessage } from '../agent.js';
import { imageResultForLLM, sanitizeToolPairsInPlace } from '../llm-message.js';

describe('imageResultForLLM', () => {
  it('extracts an image content block from an image tool result', () => {
    expect(imageResultForLLM({ type: 'image', data: 'AAA', mimeType: 'image/png' }))
      .toEqual({ type: 'image', data: 'AAA', mimeType: 'image/png' });
  });
  it('returns null for non-image results', () => {
    expect(imageResultForLLM({ type: 'text', text: 'hi' })).toBeNull();
    expect(imageResultForLLM('plain')).toBeNull();
  });
});

describe('sanitizeToolPairsInPlace', () => {
  it('drops an assistant tool_call with no matching tool_result', () => {
    const history: LLMMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'x', arguments: {} }] },
    ];
    sanitizeToolPairsInPlace(history);
    expect(history).toEqual([]);
  });
  it('keeps a complete tool_call/tool_result pair', () => {
    const history: LLMMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'x', arguments: {} }] },
      { role: 'tool_result', content: [{ type: 'tool_result', id: 'c1', content: 'ok' }] },
    ];
    const before = JSON.parse(JSON.stringify(history));
    sanitizeToolPairsInPlace(history);
    expect(history).toEqual(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dongkseo/contracts test -- llm-message`
Expected: FAIL — cannot find module `../llm-message.js`.

- [ ] **Step 3: Create the helper module**

Copy the two function bodies verbatim from `packages/architectures/src/loop-helpers.ts` (`sanitizeToolPairsInPlace` at L63, `imageResultForLLM` at L363) into the new file:

```ts
// packages/contracts/src/llm-message.ts
import type { LLMMessage, LLMContentBlock } from './agent.js';

/** Extract an image content block from a tool result, or null. */
export function imageResultForLLM(result: unknown): Extract<LLMContentBlock, { type: 'image' }> | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { type?: string; data?: string; mimeType?: string };
  if (r.type !== 'image' || typeof r.data !== 'string' || typeof r.mimeType !== 'string') return null;
  return { type: 'image', data: r.data, mimeType: r.mimeType };
}

/** Drop dangling tool_call / tool_result blocks so the provider never sees an unpaired tool turn. */
export function sanitizeToolPairsInPlace(history: LLMMessage[]): void {
  // PASTE the exact body from architectures/src/loop-helpers.ts:63-... here.
}
```

Open `packages/architectures/src/loop-helpers.ts`, read the full current body of `sanitizeToolPairsInPlace` (starts L63), and paste it exactly in place of the comment above. Do not paraphrase.

- [ ] **Step 4: Export from contracts index**

In `packages/contracts/src/index.ts`, add:

```ts
export { imageResultForLLM, sanitizeToolPairsInPlace } from './llm-message.js';
```

- [ ] **Step 5: Replace originals in loop-helpers with re-exports**

In `packages/architectures/src/loop-helpers.ts`, delete the two original function definitions and replace with a re-export near the top:

```ts
export { imageResultForLLM, sanitizeToolPairsInPlace } from '@dongkseo/contracts';
```

Keep `sanitizeToolPairsInPlace`'s existing internal callers working — they import from this module, so the re-export preserves the symbol.

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @dongkseo/contracts test -- llm-message && pnpm --filter @dongkseo/contracts typecheck && pnpm --filter @dongkseo/architectures typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/llm-message.ts packages/contracts/src/__tests__/llm-message.test.ts packages/contracts/src/index.ts packages/architectures/src/loop-helpers.ts
git commit -m "refactor(contracts): relocate pure LLM-message helpers for cross-package reuse"
```

---

## Task 2: Pure mapping layer (LLMMessage ↔ TranscriptEntry)

**Files:**
- Create: `packages/core/src/transcript-mapping.ts`
- Test: `packages/core/src/__tests__/transcript-mapping.test.ts`

**Interfaces:**
- Consumes: `LLMMessage`, `LLMContentBlock`, `ContentBlock`, `TranscriptEntry` from `@dongkseo/contracts`; `sanitizeToolPairsInPlace` (Task 1).
- Produces:
  - `llmContentToBlocks(content: string | LLMContentBlock[]): ContentBlock[]` — text/tool_call/tool_result only; throws on an `image` block (images are stored by the recorder via `putAttachment`, never inline-mapped here).
  - `toLLMMessages(entries: TranscriptEntry[], resolveImage: (ref: string, mediaType: string) => Promise<string | null>): Promise<LLMMessage[]>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/transcript-mapping.test.ts
import { describe, it, expect } from 'vitest';
import type { TranscriptEntry } from '@dongkseo/contracts';
import { llmContentToBlocks, toLLMMessages } from '../transcript-mapping.js';

const noImages = async () => null;

describe('llmContentToBlocks', () => {
  it('maps tool_call → tool_use and tool_result id → tool_use_id', () => {
    expect(llmContentToBlocks([
      { type: 'text', text: 'hi' },
      { type: 'tool_call', id: 'c1', name: 'read', arguments: { path: 'a' } },
    ])).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a' } },
    ]);
    expect(llmContentToBlocks([{ type: 'tool_result', id: 'c1', content: 'ok', isError: true }]))
      .toEqual([{ type: 'tool_result', tool_use_id: 'c1', content: 'ok', is_error: true }]);
  });
  it('wraps a plain string as a single text block', () => {
    expect(llmContentToBlocks('hello')).toEqual([{ type: 'text', text: 'hello' }]);
  });
});

describe('toLLMMessages', () => {
  const base = { conversationId: 'x', schemaVersion: 'v2' as const, timestamp: '2026-06-25T00:00:00Z' };
  it('round-trips assistant tool_use and user tool_result into rich LLM messages', async () => {
    const entries: TranscriptEntry[] = [
      { ...base, type: 'user', uuid: 'u1', parentUuid: null, content: [{ type: 'text', text: 'go' }] },
      { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: {} }] },
      { ...base, type: 'user', uuid: 'r1', parentUuid: 'a1', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
    ];
    expect(await toLLMMessages(entries, noImages)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool_result', content: [{ type: 'tool_result', id: 'c1', content: 'ok', isError: false }] },
    ]);
  });
  it('drops entries superseded by a summary and injects the summary text', async () => {
    const entries: TranscriptEntry[] = [
      { ...base, type: 'user', uuid: 'u1', parentUuid: null, content: [{ type: 'text', text: 'old' }] },
      { ...base, type: 'summary', uuid: 's1', parentUuid: 'u1', summary: 'SUMMARY', supersedesUpToUuid: 'u1' },
      { ...base, type: 'assistant', uuid: 'a2', parentUuid: 's1', content: [{ type: 'text', text: 'new' }] },
    ];
    expect(await toLLMMessages(entries, noImages)).toEqual([
      { role: 'user', content: 'SUMMARY' },
      { role: 'assistant', content: [{ type: 'text', text: 'new' }] },
    ]);
  });
  it('resolves attachment_ref images to base64 blocks', async () => {
    const entries: TranscriptEntry[] = [
      { ...base, type: 'user', uuid: 'u1', parentUuid: null, content: [
        { type: 'image', source: { type: 'attachment_ref', ref: 'abc.png', media_type: 'image/png' } },
      ] },
    ];
    const resolve = async (ref: string) => (ref === 'abc.png' ? 'BYTES' : null);
    expect(await toLLMMessages(entries, resolve)).toEqual([
      { role: 'user', content: [{ type: 'image', data: 'BYTES', mimeType: 'image/png' }] },
    ]);
  });
  it('removes a dangling tool_use whose result never arrived', async () => {
    const entries: TranscriptEntry[] = [
      { ...base, type: 'assistant', uuid: 'a1', parentUuid: null, content: [{ type: 'tool_use', id: 'c1', name: 'x', input: {} }] },
    ];
    expect(await toLLMMessages(entries, noImages)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dongkseo/core test -- transcript-mapping`
Expected: FAIL — cannot find module `../transcript-mapping.js`.

- [ ] **Step 3: Implement the mapping**

```ts
// packages/core/src/transcript-mapping.ts
import type {
  LLMMessage, LLMContentBlock, ContentBlock, TranscriptEntry,
} from '@dongkseo/contracts';
import { sanitizeToolPairsInPlace } from '@dongkseo/contracts';

/** LLMContentBlock[] (or string) → transcript ContentBlock[]. Images are NOT handled here. */
export function llmContentToBlocks(content: string | LLMContentBlock[]): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map((b): ContentBlock => {
    switch (b.type) {
      case 'text': return { type: 'text', text: b.text };
      case 'tool_call': return { type: 'tool_use', id: b.id, name: b.name, input: b.arguments };
      case 'tool_result': return { type: 'tool_result', tool_use_id: b.id, content: b.content, is_error: b.isError ?? false };
      case 'image': throw new Error('llmContentToBlocks: image blocks must be stored via putAttachment by the recorder');
    }
  });
}

function blocksToLLMContent(
  blocks: ContentBlock[],
  images: Array<{ data: string; mimeType: string }>,
): LLMContentBlock[] {
  const out: LLMContentBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') out.push({ type: 'tool_call', id: b.id, name: b.name, arguments: b.input });
    else if (b.type === 'tool_result') {
      const content = typeof b.content === 'string' ? b.content : b.content.map(c => (c.type === 'text' ? c.text : '[image]')).join('');
      out.push({ type: 'tool_result', id: b.tool_use_id, content, isError: b.is_error ?? false });
    } else if (b.type === 'image') {
      // image blocks are appended after resolution by the caller (see toLLMMessages)
    }
  }
  // images resolved out-of-band are appended by the caller
  void images;
  return out;
}

/** Replay transcript entries → rich LLM messages. Applies summary supersede, resolves images, sanitizes tool pairs. */
export async function toLLMMessages(
  entries: TranscriptEntry[],
  resolveImage: (ref: string, mediaType: string) => Promise<string | null>,
): Promise<LLMMessage[]> {
  // 1. Apply the LAST summary's supersede boundary.
  let kept = entries;
  const summaries = entries.filter((e): e is Extract<TranscriptEntry, { type: 'summary' }> => e.type === 'summary');
  const lastSummary = summaries[summaries.length - 1];
  const messages: LLMMessage[] = [];
  if (lastSummary) {
    const cutIdx = entries.findIndex(e => e.uuid === lastSummary.supersedesUpToUuid);
    kept = entries.slice(cutIdx + 1);
    messages.push({ role: 'user', content: lastSummary.summary });
  }

  // 2. Map each content entry, resolving image blocks via the injected resolver.
  for (const e of kept) {
    if (e.type === 'summary' || e.type === 'attachment' || e.type === 'system') continue;
    const content: LLMContentBlock[] = blocksToLLMContent(e.content, []);
    for (const b of e.content) {
      if (b.type === 'image') {
        if (b.source.type === 'attachment_ref') {
          const data = await resolveImage(b.source.ref, b.source.media_type);
          if (data) content.push({ type: 'image', data, mimeType: b.source.media_type });
        } else if (b.source.type === 'base64') {
          content.push({ type: 'image', data: b.source.data, mimeType: b.source.media_type });
        }
      }
    }
    messages.push({ role: e.type === 'assistant' ? 'assistant' : roleForUserEntry(e.content), content });
  }

  // 3. Drop dangling tool pairs so the provider never 400s.
  sanitizeToolPairsInPlace(messages);
  return messages;
}

/** A user entry carrying tool_result blocks must use role 'tool_result'; otherwise 'user'. */
function roleForUserEntry(blocks: ContentBlock[]): 'user' | 'tool_result' {
  return blocks.some(b => b.type === 'tool_result') ? 'tool_result' : 'user';
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @dongkseo/core test -- transcript-mapping && pnpm --filter @dongkseo/core typecheck`
Expected: PASS. If the `blocksToLLMContent`/image append ordering double-adds images, fix by removing the image branch from `blocksToLLMContent` (it is already a no-op) — images are appended only in `toLLMMessages`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/transcript-mapping.ts packages/core/src/__tests__/transcript-mapping.test.ts
git commit -m "feat(core): pure LLMMessage <-> TranscriptEntry mapping with summary + image replay"
```

---

## Task 3: TranscriptMemoryProvider

**Files:**
- Create: `packages/core/src/transcript-memory.ts`
- Test: `packages/core/src/__tests__/transcript-memory.test.ts`

**Interfaces:**
- Consumes: `TranscriptStore`, `MemoryProvider` (post-Task-5 rich shape — but this task ships against the rich return type directly), `toLLMMessages` (Task 2). `TwoStageCompactor` from `./compaction.js` (optional).
- Produces: `class TranscriptMemoryProvider { constructor(store: TranscriptStore, conversationId: string, opts?: { compactor?: Compactor }) }` implementing `getHistory(): Promise<LLMMessage[]>`, `append(): Promise<void>` (no-op), `compact(): Promise<string | null>`, `clear(): Promise<void>`.

> NOTE: This task defines `getHistory` returning `Promise<LLMMessage[]>` ahead of the contract widening in Task 5. That is intentional — Task 5 makes the `MemoryProvider` interface match. Until Task 5 lands, this class does not yet `implements MemoryProvider`; add the `implements` clause in Task 5.

- [ ] **Step 1: Write the failing test** (uses a fake in-memory `TranscriptStore`)

```ts
// packages/core/src/__tests__/transcript-memory.test.ts
import { describe, it, expect } from 'vitest';
import type { TranscriptStore, TranscriptEntry, AttachmentRef } from '@dongkseo/contracts';
import { TranscriptMemoryProvider } from '../transcript-memory.js';

function fakeStore(seed: TranscriptEntry[] = []): TranscriptStore & { entries: TranscriptEntry[] } {
  const entries = [...seed];
  return {
    entries,
    appendEntry: async (e: TranscriptEntry) => { entries.push(e); },
    flush: async () => {},
    async *getEntries(_id, opts) { const s = opts?.limit ? Math.max(0, entries.length - opts.limit) : 0; for (let i = s; i < entries.length; i++) yield entries[i]; },
    putAttachment: async (): Promise<AttachmentRef> => ({ ref: 'r', mediaType: 'image/png', size: 0 }),
    getAttachment: async () => null,
    deleteConversation: async () => { entries.length = 0; },
  };
}
const base = { conversationId: 'c', schemaVersion: 'v2' as const, timestamp: '2026-06-25T00:00:00Z' };

describe('TranscriptMemoryProvider', () => {
  it('getHistory replays stored entries as rich LLM messages', async () => {
    const store = fakeStore([
      { ...base, type: 'user', uuid: 'u1', parentUuid: null, content: [{ type: 'text', text: 'go' }] },
      { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: {} }] },
      { ...base, type: 'user', uuid: 'r1', parentUuid: 'a1', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
    ]);
    const mem = new TranscriptMemoryProvider(store, 'c');
    expect(await mem.getHistory()).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool_result', content: [{ type: 'tool_result', id: 'c1', content: 'ok', isError: false }] },
    ]);
  });
  it('append is a no-op (recorder is the writer)', async () => {
    const store = fakeStore();
    const mem = new TranscriptMemoryProvider(store, 'c');
    await mem.append({ role: 'user', content: 'x' });
    expect(store.entries).toEqual([]);
  });
  it('clear delegates to deleteConversation', async () => {
    const store = fakeStore([{ ...base, type: 'user', uuid: 'u1', parentUuid: null, content: [] }]);
    const mem = new TranscriptMemoryProvider(store, 'c');
    await mem.clear();
    expect(store.entries).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dongkseo/core test -- transcript-memory`
Expected: FAIL — cannot find module `../transcript-memory.js`.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/transcript-memory.ts
import type { TranscriptStore, LLMMessage } from '@dongkseo/contracts';
import { toLLMMessages } from './transcript-mapping.js';
import type { Compactor } from './compaction.js';

export interface TranscriptMemoryProviderOptions {
  compactor?: Compactor;
}

export class TranscriptMemoryProvider {
  constructor(
    private readonly store: TranscriptStore,
    private readonly conversationId: string,
    private readonly opts: TranscriptMemoryProviderOptions = {},
  ) {}

  async getHistory(limit?: number): Promise<LLMMessage[]> {
    const entries = [];
    for await (const e of this.store.getEntries(this.conversationId, limit ? { limit } : undefined)) {
      entries.push(e);
    }
    return toLLMMessages(entries, (ref, mediaType) =>
      this.store.getAttachment(this.conversationId, ref).then(buf =>
        buf ? buf.toString('base64') : null,
      ).then(d => { void mediaType; return d; }),
    );
  }

  // The runtime recorder is the single writer; the architecture no longer appends.
  async append(_message: LLMMessage): Promise<void> { /* no-op */ }

  async compact(): Promise<string | null> {
    if (!this.opts.compactor) return null;
    // Summarize the current text projection, then mark a supersede boundary.
    // Detailed summary-entry write is implemented in Task 8 (compaction wiring); here it is a no-op stub returning null.
    return null;
  }

  async clear(): Promise<void> {
    await this.store.deleteConversation(this.conversationId);
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @dongkseo/core test -- transcript-memory && pnpm --filter @dongkseo/core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/transcript-memory.ts packages/core/src/__tests__/transcript-memory.test.ts
git commit -m "feat(core): TranscriptMemoryProvider — rich getHistory replay over TranscriptStore"
```

---

## Task 4: TranscriptRecorder (single writer)

**Files:**
- Create: `packages/core/src/transcript-recorder.ts`
- Test: `packages/core/src/__tests__/transcript-recorder.test.ts`

**Interfaces:**
- Consumes: `TranscriptStore`, `AgentInput`, `AgentEvent`, `LLMUsage` from `@dongkseo/contracts`; `imageResultForLLM` (Task 1); `llmContentToBlocks` (Task 2). `randomUUID` from `node:crypto`.
- Produces: `class TranscriptRecorder { constructor(store: TranscriptStore, conversationId: string); recordUserInput(input: AgentInput): Promise<void>; onEvent(event: AgentEvent): Promise<void>; recordSteer(text: string): Promise<void>; flush(): Promise<void> }`

**State machine (event order is deterministic per ReAct/plan-execute iteration):** accumulate `text` deltas → on first `tool_call`, buffer consecutive tool_calls → on first `tool_result`, flush an `assistant` entry `[text?, tool_use...]` → buffer tool_results (extract images via `imageResultForLLM` → `putAttachment` → `attachment_ref` block) → flush a `user` entry → reset → on `done`, flush the final `assistant` entry with `model`/`usage`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/transcript-recorder.test.ts
import { describe, it, expect } from 'vitest';
import type { TranscriptStore, TranscriptEntry, AttachmentRef } from '@dongkseo/contracts';
import { TranscriptRecorder } from '../transcript-recorder.js';

function fakeStore(): TranscriptStore & { entries: TranscriptEntry[] } {
  const entries: TranscriptEntry[] = [];
  return {
    entries,
    appendEntry: async (e) => { entries.push(e); },
    flush: async () => {},
    async *getEntries() { for (const e of entries) yield e; },
    putAttachment: async (): Promise<AttachmentRef> => ({ ref: 'img.png', mediaType: 'image/png', size: 3 }),
    getAttachment: async () => null,
    deleteConversation: async () => {},
  };
}

describe('TranscriptRecorder', () => {
  it('records user → assistant(tool_use) → user(tool_result) with linked ids and parent chain', async () => {
    const store = fakeStore();
    const rec = new TranscriptRecorder(store, 'c');
    await rec.recordUserInput({ prompt: 'read the file' });
    await rec.onEvent({ type: 'text', text: 'reading' });
    await rec.onEvent({ type: 'tool_call', id: 'c1', name: 'read', input: { path: 'a' } });
    await rec.onEvent({ type: 'tool_result', id: 'c1', name: 'read', result: { type: 'text', text: 'CONTENT' }, isError: false });
    await rec.onEvent({ type: 'done', content: 'done', toolCalls: [] });
    await rec.flush();

    const types = store.entries.map(e => e.type);
    expect(types).toEqual(['user', 'assistant', 'user', 'assistant']);

    const asst = store.entries[1] as Extract<TranscriptEntry, { type: 'assistant' }>;
    expect(asst.content).toEqual([
      { type: 'text', text: 'reading' },
      { type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a' } },
    ]);
    const toolUser = store.entries[2] as Extract<TranscriptEntry, { type: 'user' }>;
    expect(toolUser.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'CONTENT', is_error: false },
    ]);
    // parent chain is linear
    expect(store.entries[1].parentUuid).toBe(store.entries[0].uuid);
    expect(store.entries[2].parentUuid).toBe(store.entries[1].uuid);
    expect(store.entries[3].parentUuid).toBe(store.entries[2].uuid);
  });

  it('records a no-tool turn as a single assistant entry on done', async () => {
    const store = fakeStore();
    const rec = new TranscriptRecorder(store, 'c');
    await rec.recordUserInput({ prompt: 'hi' });
    await rec.onEvent({ type: 'text', text: 'hello there' });
    await rec.onEvent({ type: 'done', content: 'hello there', toolCalls: [], model: 'm', usage: { promptTokens: 1, completionTokens: 2 } });
    await rec.flush();
    expect(store.entries.map(e => e.type)).toEqual(['user', 'assistant']);
    const asst = store.entries[1] as Extract<TranscriptEntry, { type: 'assistant' }>;
    expect(asst.content).toEqual([{ type: 'text', text: 'hello there' }]);
    expect(asst.model).toBe('m');
  });

  it('stores a tool image as an attachment_ref block', async () => {
    const store = fakeStore();
    const rec = new TranscriptRecorder(store, 'c');
    await rec.recordUserInput({ prompt: 'screenshot' });
    await rec.onEvent({ type: 'tool_call', id: 'c1', name: 'shot', input: {} });
    await rec.onEvent({ type: 'tool_result', id: 'c1', name: 'shot', result: { type: 'image', data: 'QUJD', mimeType: 'image/png' }, isError: false });
    await rec.onEvent({ type: 'done', content: '', toolCalls: [] });
    await rec.flush();
    const toolUser = store.entries.find(e => e.type === 'user' && e.parentUuid === store.entries[1].uuid) as Extract<TranscriptEntry, { type: 'user' }>;
    expect(toolUser.content).toContainEqual({ type: 'image', source: { type: 'attachment_ref', ref: 'img.png', media_type: 'image/png' } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dongkseo/core test -- transcript-recorder`
Expected: FAIL — cannot find module `../transcript-recorder.js`.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/transcript-recorder.ts
import { randomUUID } from 'node:crypto';
import type {
  TranscriptStore, TranscriptEntry, AgentInput, AgentEvent, ContentBlock, ImageContent,
} from '@dongkseo/contracts';
import { imageResultForLLM } from '@dongkseo/contracts';

export class TranscriptRecorder {
  private lastUuid: string | null = null;
  private pendingText = '';
  private pendingToolUses: ContentBlock[] = [];
  private pendingToolResults: ContentBlock[] = [];
  private mode: 'idle' | 'collecting-results' = 'idle';

  constructor(
    private readonly store: TranscriptStore,
    private readonly conversationId: string,
  ) {}

  private base() {
    return {
      conversationId: this.conversationId,
      schemaVersion: 'v2' as const,
      timestamp: new Date().toISOString(),
    };
  }

  private async write(entry: TranscriptEntry): Promise<void> {
    this.lastUuid = entry.uuid;
    try { await this.store.appendEntry(entry); } catch { /* best-effort */ }
  }

  async recordUserInput(input: AgentInput): Promise<void> {
    const content: ContentBlock[] = [{ type: 'text', text: input.prompt }];
    for (const img of input.images ?? []) content.push(await this.imageBlock(img));
    await this.write({ ...this.base(), type: 'user', uuid: randomUUID(), parentUuid: this.lastUuid, content });
  }

  async recordSteer(text: string): Promise<void> {
    await this.flushPendingAssistant();
    await this.flushPendingToolResults();
    await this.write({ ...this.base(), type: 'user', uuid: randomUUID(), parentUuid: this.lastUuid, content: [{ type: 'text', text }] });
  }

  async onEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'text':
        if (this.mode === 'collecting-results') await this.flushPendingToolResults();
        this.pendingText += event.text;
        break;
      case 'tool_call':
        if (this.mode === 'collecting-results') await this.flushPendingToolResults();
        this.pendingToolUses.push({ type: 'tool_use', id: event.id, name: event.name, input: event.input });
        break;
      case 'tool_result': {
        if (this.mode !== 'collecting-results') { await this.flushPendingAssistant(); this.mode = 'collecting-results'; }
        this.pendingToolResults.push({ type: 'tool_result', tool_use_id: event.id, content: stringifyResult(event.result), is_error: event.isError });
        const img = imageResultForLLM(event.result);
        if (img) this.pendingToolResults.push(await this.imageBlock({ type: 'image', data: img.data, mimeType: img.mimeType }));
        break;
      }
      case 'done':
        if (this.mode === 'collecting-results') await this.flushPendingToolResults();
        await this.flushPendingAssistant({ model: event.model, usage: event.usage });
        break;
      default:
        break; // thinking/progress/artifact/suspended/error not persisted as turns here
    }
  }

  private async flushPendingAssistant(meta?: { model?: string; usage?: AgentEvent extends { usage?: infer U } ? U : never }): Promise<void> {
    if (!this.pendingText && this.pendingToolUses.length === 0) return;
    const content: ContentBlock[] = [];
    if (this.pendingText) content.push({ type: 'text', text: this.pendingText });
    content.push(...this.pendingToolUses);
    await this.write({
      ...this.base(), type: 'assistant', uuid: randomUUID(), parentUuid: this.lastUuid, content,
      ...(meta?.model ? { model: meta.model } : {}),
      ...(meta?.usage ? { usage: { inputTokens: meta.usage.promptTokens, outputTokens: meta.usage.completionTokens } } : {}),
    });
    this.pendingText = '';
    this.pendingToolUses = [];
  }

  private async flushPendingToolResults(): Promise<void> {
    if (this.pendingToolResults.length === 0) { this.mode = 'idle'; return; }
    await this.write({ ...this.base(), type: 'user', uuid: randomUUID(), parentUuid: this.lastUuid, content: this.pendingToolResults });
    this.pendingToolResults = [];
    this.mode = 'idle';
  }

  private async imageBlock(img: ImageContent): Promise<ContentBlock> {
    const buf = Buffer.from(img.data, 'base64');
    const ref = await this.store.putAttachment(this.conversationId, buf, img.mimeType);
    return { type: 'image', source: { type: 'attachment_ref', ref: ref.ref, media_type: img.mimeType } };
  }

  async flush(): Promise<void> {
    await this.flushPendingToolResults();
    await this.flushPendingAssistant();
    await this.store.flush();
  }
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const r = result as { type?: string; text?: string; message?: string };
    if (r.type === 'text' && typeof r.text === 'string') return r.text;
    if (r.type === 'error' && typeof r.message === 'string') return `[ERROR] ${r.message}`;
    if (r.type === 'image') return '[image]';
  }
  return JSON.stringify(result);
}
```

> If the `meta.usage` conditional type is awkward to typecheck, replace the `meta` param type with an explicit `{ model?: string; usage?: { promptTokens?: number; completionTokens?: number } }`.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @dongkseo/core test -- transcript-recorder && pnpm --filter @dongkseo/core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/transcript-recorder.ts packages/core/src/__tests__/transcript-recorder.test.ts
git commit -m "feat(core): TranscriptRecorder — event-driven single writer for rich transcript turns"
```

---

## Task 5: Widen contracts + retire CoreMemoryProvider

**Files:**
- Modify: `packages/contracts/src/agent.ts:273-285` (`MemoryProvider`), `:11-21` (`AgentInput.history`)
- Modify: `packages/core/src/execution-harness.ts:278-283` (`NullMemory`)
- Modify: `packages/core/src/transcript-memory.ts` (add `implements MemoryProvider`)
- Modify: `packages/core/src/index.ts` (remove `CoreMemoryProvider` export, add new modules)
- Delete: `packages/core/src/memory.ts` and its test
- Test: typecheck across the workspace is the gate here.

**Interfaces:**
- Produces: `MemoryProvider.getHistory(limit?): Promise<LLMMessage[]>`, `MemoryProvider.append(message: LLMMessage): Promise<void>`, `AgentInput.history?: LLMMessage[]`.

- [ ] **Step 1: Widen `MemoryProvider` and `AgentInput`**

In `packages/contracts/src/agent.ts`:

```ts
export interface MemoryProvider {
  append(message: LLMMessage): Promise<void>;
  getHistory(limit?: number): Promise<LLMMessage[]>;
  compact(): Promise<string | null>;
  clear(): Promise<void>;
}
```

and change `AgentInput.history`:

```ts
  /** 이전 대화 히스토리 (rich — tool/image 블록 포함) */
  history?: LLMMessage[];
```

- [ ] **Step 2: Run workspace typecheck to enumerate breakages**

Run: `pnpm -r typecheck`
Expected: FAIL in `core` (`memory.ts`, `execution-harness.ts` `NullMemory`), `architectures` (`react.ts`, `plan-execute.ts`), `adapters/src/http.ts`. Record the list — Steps 3–6 and Task 6/7 clear them.

- [ ] **Step 3: Update `NullMemory`**

In `packages/core/src/execution-harness.ts` (`class NullMemory`):

```ts
class NullMemory implements MemoryProvider {
  async append(): Promise<void> {}
  async getHistory(): Promise<LLMMessage[]> { return []; }
  async compact(): Promise<null> { return null; }
  async clear(): Promise<void> {}
}
```

Add `LLMMessage` to the `@dongkseo/contracts` import in that file if not present.

- [ ] **Step 4: Delete CoreMemoryProvider**

```bash
git rm packages/core/src/memory.ts
```

If a test `packages/core/src/__tests__/memory.test.ts` exists, `git rm` it too.

- [ ] **Step 5: Update core barrel + add `implements`**

In `packages/core/src/index.ts`: remove the `export { CoreMemoryProvider } ...` and `CoreMemoryProviderOptions` lines; add:

```ts
export { TranscriptMemoryProvider } from './transcript-memory.js';
export type { TranscriptMemoryProviderOptions } from './transcript-memory.js';
export { TranscriptRecorder } from './transcript-recorder.js';
export { toLLMMessages, llmContentToBlocks } from './transcript-mapping.js';
```

In `packages/core/src/transcript-memory.ts`, change the class declaration to `export class TranscriptMemoryProvider implements MemoryProvider` and import `MemoryProvider`.

- [ ] **Step 6: Fix the http adapter boundary**

In `packages/adapters/src/http.ts:262-263`, `history` is built from request body as `ChatMessage[]`. Convert text chat messages to `LLMMessage` at this edge:

```ts
history: Array.isArray(body.history)
  ? body.history.filter(isChatMessage).map((m) => ({ role: m.role, content: m.content }))
  : undefined,
```

(`{role, content: string}` is already a valid `LLMMessage`.) Adjust the typed target to `LLMMessage[]` and keep `isChatMessage` as the wire validator.

- [ ] **Step 7: Run typecheck (core + contracts + adapters)**

Run: `pnpm --filter @dongkseo/contracts --filter @dongkseo/core --filter @dongkseo/adapters typecheck`
Expected: PASS (architectures still failing — fixed in Task 7).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(contracts): widen MemoryProvider + AgentInput.history to rich LLMMessage; retire CoreMemoryProvider"
```

---

## Task 6: Surface TranscriptStore through the store factory

**Files:**
- Modify: `packages/store/src/factory.ts:22-35` (`StoreProvider`)
- Modify: `packages/store-json/src/index.ts` (`JsonStoreProvider` + `createJsonStoreProvider`)
- Test: `packages/store-json/src/__tests__/stores.test.ts` (extend)

**Interfaces:**
- Produces: `StoreProvider.transcript?: TranscriptStore`; `JsonStoreProvider.transcript: TranscriptStoreJson`.

- [ ] **Step 1: Write the failing test**

In `packages/store-json/src/__tests__/stores.test.ts`, add:

```ts
it('provider exposes a transcript store', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonstore-'));
  const provider = createJsonStoreProvider(dir);
  expect(provider.transcript).toBeDefined();
  await provider.transcript.appendEntry({
    type: 'user', uuid: 'u1', parentUuid: null, conversationId: 'c',
    schemaVersion: 'v2', timestamp: '2026-06-25T00:00:00Z', content: [{ type: 'text', text: 'hi' }],
  });
  await provider.transcript.flush();
  const got = [];
  for await (const e of provider.transcript.getEntries('c')) got.push(e);
  expect(got).toHaveLength(1);
});
```

(Match the existing import style in that test file for `fs`/`path`/`os`/`createJsonStoreProvider`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dongkseo/store-json test -- stores`
Expected: FAIL — `provider.transcript` is undefined.

- [ ] **Step 3: Add transcript to the contract**

In `packages/store/src/factory.ts`, import `TranscriptStore` and add to `StoreProvider`:

```ts
  /** Rich append-only transcript store (system of record). Optional until all backends implement it. */
  transcript?: TranscriptStore;
```

- [ ] **Step 4: Add transcript to JsonStoreProvider**

In `packages/store-json/src/index.ts`: add `transcript: TranscriptStoreJson;` to the `JsonStoreProvider` interface, import nothing new (already exports `TranscriptStoreJson`), and in `createJsonStoreProvider` add:

```ts
    transcript: new TranscriptStoreJson(dataDir),
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @dongkseo/store --filter @dongkseo/store-json typecheck && pnpm --filter @dongkseo/store-json test -- stores`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/store/src/factory.ts packages/store-json/src/index.ts packages/store-json/src/__tests__/stores.test.ts
git commit -m "feat(store): surface TranscriptStore through StoreProvider + JsonStoreProvider"
```

---

## Task 7: Rich replay wiring in architectures

**Files:**
- Modify: `packages/architectures/src/react.ts:80-92, 108, 154`
- Modify: `packages/architectures/src/plan-execute.ts:96-100` (and its assistant/user append + memory.append sites)
- Test: `packages/architectures/src/__tests__/react.test.ts` (extend)

**Interfaces:**
- Consumes: `services.memory.getHistory(): Promise<LLMMessage[]>` (Task 5); `input.history: LLMMessage[]` (Task 5).

- [ ] **Step 1: Write the failing test** — getHistory rich messages flow into the loop

In `react.test.ts`, add a test using the existing mock-LLM harness: seed `services.memory.getHistory` to return a tool_result-bearing `LLMMessage[]`, run the loop with a mock LLM that immediately returns a no-tool answer, and assert the first LLM `stream` call received those rich messages as leading history.

```ts
it('seeds rich history (tool blocks) from memory.getHistory into the LLM call', async () => {
  const richHistory: LLMMessage[] = [
    { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'read', arguments: {} }] },
    { role: 'tool_result', content: [{ type: 'tool_result', id: 'c1', content: 'FILE', isError: false }] },
  ];
  const seen: LLMMessage[][] = [];
  const llm = makeMockLLM({ onStream: (msgs) => seen.push(msgs), reply: 'done' });
  const services = makeServices({ llm, memory: { getHistory: async () => richHistory, append: async () => {}, compact: async () => null, clear: async () => {} } });
  const arch = createReactArchitecture({ systemPrompt: 's' });
  for await (const _ of arch.loop(services, { prompt: 'go' })) { /* drain */ }
  expect(seen[0].slice(0, 2)).toEqual(richHistory);
});
```

(Adapt `makeMockLLM`/`makeServices` to the helpers already present in `react.test.ts`/`mock-llm.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dongkseo/architectures test -- react`
Expected: FAIL — `getHistory` mapping currently coerces to `{role, content:string}`, dropping the tool blocks.

- [ ] **Step 3: Replace history seeding in react.ts**

In `packages/architectures/src/react.ts`, replace L80–86:

```ts
        // 1. 이전 대화 히스토리 (rich — tool/image 블록 그대로)
        history.push(...await services.memory.getHistory());
        history.push(...(input.history ?? []));
```

- [ ] **Step 4: Remove memory.append calls (recorder is the writer)**

In `react.ts`, delete the three `await services.memory.append(...)` calls at L91, L108, L154. Keep every `history.push(...)` (the in-loop LLM context still needs them). The user prompt push at L90 stays:

```ts
        // 2. 현재 사용자 입력
        const userContent = userContentForInput(input);
        history.push({ role: 'user', content: userContent });
```

- [ ] **Step 5: Mirror in plan-execute.ts**

Apply the same two changes in `plan-execute.ts`: replace the `getHistory()` text mapping + `input.history` loop (L96–100) with rich `history.push(...)`, and remove its `memory.append` calls.

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @dongkseo/architectures test && pnpm --filter @dongkseo/architectures typecheck`
Expected: PASS. Fix any remaining tests that asserted on `memory.append` being called — update them to assert the recorder/transcript behavior is no longer the architecture's job.

- [ ] **Step 7: Commit**

```bash
git add packages/architectures/src/react.ts packages/architectures/src/plan-execute.ts packages/architectures/src/__tests__/react.test.ts
git commit -m "feat(architectures): seed rich history from memory; stop text-only memory.append"
```

---

## Task 8: Drive the recorder from the harness + compaction summary

**Files:**
- Modify: `packages/core/src/execution-harness.ts:34-53` (options), `:98-257` (execute), `steer()`
- Modify: `packages/core/src/transcript-memory.ts` (`compact()` writes a `SummaryTranscriptEntry`)
- Test: `packages/core/src/__tests__/transcript-recorder-harness.test.ts` (integration)

**Interfaces:**
- Consumes: `TranscriptRecorder`, `TranscriptMemoryProvider`, `TranscriptStore`.
- Produces: `LocalExecutionHarnessOptions.transcript?: TranscriptStore`, `LocalExecutionHarnessOptions.conversationId?: string`.

- [ ] **Step 1: Write the failing integration test** — two executions, tool turn persisted then replayed

```ts
// packages/core/src/__tests__/transcript-recorder-harness.test.ts
import { describe, it, expect } from 'vitest';
import { LocalExecutionHarness } from '../execution-harness.js';
import { TranscriptMemoryProvider } from '../transcript-memory.js';
// build an in-memory TranscriptStore (reuse the fakeStore pattern from transcript-recorder.test.ts)
// build a mock LLM + single-tool executor + a react architecture

it('persists a tool turn in execution 1 and replays it as rich history in execution 2', async () => {
  // exec 1: mock LLM calls tool `read` once, then answers.
  // exec 2: assert the LLM's first stream() call includes the assistant tool_call + tool_result from exec 1.
  // (Full harness construction mirrors existing execution-harness tests; assert on captured stream messages.)
});
```

Flesh this out against the existing `execution-harness` test setup (mock LLM, mock tool executor, `createReactArchitecture`). The assertion: `capturedSecondRunFirstStream` contains a `tool_call`/`tool_result` pair with id linkage.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dongkseo/core test -- transcript-recorder-harness`
Expected: FAIL — recorder not wired; nothing persisted between runs.

- [ ] **Step 3: Add harness options**

In `packages/core/src/execution-harness.ts`, add to `LocalExecutionHarnessOptions`:

```ts
  /** Rich transcript store (system of record). When set with conversationId, the harness records every turn. */
  transcript?: TranscriptStore;
  /** Conversation key for transcript recording/replay. */
  conversationId?: string;
```

Store them on the instance in the constructor; import `TranscriptStore` and `TranscriptRecorder`.

- [ ] **Step 4: Build + drive the recorder in execute()**

At the top of `execute()` (after the controller setup), build the recorder when configured and record the inbound input:

```ts
    const recorder = (this.transcript && this.conversationId)
      ? new TranscriptRecorder(this.transcript, this.conversationId)
      : null;
    if (recorder && !input.resumeContext) await recorder.recordUserInput(input);
```

In the event loop (the `for await (const event of events)` block), after `collectedEvents.push(event)` and before `yield event`, feed the recorder:

```ts
        if (recorder) await recorder.onEvent(event);
```

In the `finally` block, flush:

```ts
      if (recorder) { try { await recorder.flush(); } catch { /* best-effort */ } }
```

- [ ] **Step 5: Record steers**

In `steer(text)`, when a recorder exists for the active execution, also `void recorder.recordSteer(text)`. (If `steer` cannot see the per-execute recorder, hold the active recorder in an instance field set at execute() start and cleared in `finally`.)

- [ ] **Step 6: Implement compaction summary write**

In `TranscriptMemoryProvider.compact()`, when a compactor is set: read entries → project to text (`toLLMMessages` then flatten text) → `compactor.compact(...)` → if it returns a summary, `await this.store.appendEntry({ type:'summary', uuid: randomUUID(), parentUuid: <last leaf uuid>, conversationId, schemaVersion:'v2', timestamp, summary, supersedesUpToUuid: <last leaf uuid> })`. Add a unit test asserting a summary entry is written and `getHistory` then returns the summary + post-summary entries only (the Task 2 supersede test already covers replay).

- [ ] **Step 7: Run tests + full typecheck**

Run: `pnpm --filter @dongkseo/core test && pnpm -r typecheck`
Expected: PASS across the workspace.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): drive TranscriptRecorder from the harness; transcript-native compaction summary"
```

---

## Task 9: Full build, lint, and example smoke

**Files:** none (verification task).

- [ ] **Step 1: Workspace build + test + lint**

Run: `pnpm -r build && pnpm -r test && pnpm -r lint`
Expected: all PASS. Fix any straggler references to `CoreMemoryProvider` or text-only `getHistory` the typechecker missed (e.g. in `examples/`).

- [ ] **Step 2: Manually confirm a transcript file is written**

Wire a json store provider into one example/dev entrypoint (pass `transcript: provider.transcript` + a `conversationId` into the harness options) and run one turn that calls a tool. Confirm `{dataDir}/transcripts/{conversationId}.jsonl` exists and contains a `user`, an `assistant` with a `tool_use` block, and a `user` with a `tool_result` block (ids linked).

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "chore: wire transcript store into dev entrypoint; fix stragglers"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** contract widening (Task 5), mapping (Task 2), TranscriptMemoryProvider (Task 3), recorder (Task 4), replay wiring (Task 7), store plumbing (Task 6), harness drive + compaction (Task 8), helper relocation (Task 1), greenfield (no migration task — intentional). All spec sections mapped.
- **Open risks tracked:** store-pg divergence → `StoreProvider.transcript` is optional (Task 6) so pg compiles; pg `TranscriptStore` is an explicit follow-up, not in this plan. Helper cycle → resolved by placing helpers in `contracts` (Task 1). `AgentInput` media fields → confirmed `images?: ImageContent[]`, `files?: FileContent[]`; recorder maps `images` (files deferred — note in Task 4 if file attachments are needed later).
- **Type consistency:** `getHistory(): Promise<LLMMessage[]>`, `tool_call{id,name,arguments}`↔`tool_use{id,name,input}`, `tool_result{id,content,isError}`↔`ToolResultBlock{tool_use_id,content,is_error}`, `imageResultForLLM`/`sanitizeToolPairsInPlace` names consistent across Tasks 1–8.
- **Note:** `files?: FileContent[]` on `AgentInput` is not persisted by the recorder in this plan (only `images`). If file replay is required, add a follow-up task — flagged here to avoid silent scope drop.
