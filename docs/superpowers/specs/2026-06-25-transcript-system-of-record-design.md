# Transcript as System of Record — Design

- **Date:** 2026-06-25
- **Status:** Draft (awaiting review)
- **Scope:** `@dongkseo/contracts`, `@dongkseo/core`, `@dongkseo/architectures`, `@dongkseo/store` + `@dongkseo/store-json`

## Goal

Make `TranscriptStore` the single **system of record** for conversation history.
Capture `tool_use` / `tool_result` / images as rich `ContentBlock`s during execution,
and replay them as rich `LLMMessage`s to the model on the next turn. Fully replace the
text-only `ConversationStore`-backed memory path.

This closes the current gap: tool calls and images flow through the runtime as
`AgentEvent`s but are never persisted, because cross-turn memory (`MemoryProvider` →
`ConversationStore`) is text-only (`ChatMessage = {role, content: string}`).

## Locked decisions

| Decision | Choice |
|---|---|
| Layer | nexora **core + contracts** (not app-level cast) |
| ConversationStore | **Full replacement** — transcript-backed memory becomes the only history source |
| Migration | **Greenfield** — existing `conversations/*.jsonl` discarded (dev backend) |
| Recorder hook | **A1 — runtime recorder** driven by the harness `AgentEvent` stream (single writer at the runtime layer) |

## Key finding: the store layer already matches Claude Code

nexora's `TranscriptEntry` schema (`contracts/src/transcript.ts`) + `TranscriptStoreJson`
already mirror Claude Code's on-disk transcript model 1:1:

| Claude Code | nexora (exists today) |
|---|---|
| `<sessionId>.jsonl` append-only | `{dataDir}/transcripts/{convId}.jsonl` append-only |
| `type`-discriminated entry union | `TranscriptEntry` union (user/assistant/system/attachment/summary) |
| `uuid` / `parentUuid` chain (tree) | `uuid` / `parentUuid` |
| `tool_use.id` ↔ `tool_result.tool_use_id` inline | `ToolUseBlock.id` ↔ `ToolResultBlock.tool_use_id` |
| large image → external hash file, small → inline base64 | `attachment_ref` (`putAttachment`) vs `base64` source |
| compaction = summary entry + archive boundary, originals kept | `SummaryTranscriptEntry.supersedesUpToUuid` |
| batched flush (100 entries / 100 ms) | `TranscriptStoreJson` microtask-batched flush |

**Therefore the store + schema are done.** Only two pieces are missing: a **recorder**
(write rich entries during execution) and a **replay channel** (read entries → rich
`LLMMessage[]`).

## Architecture

### 1. Contract changes (`@dongkseo/contracts`)

Widen the replay channel to carry rich messages:

- `MemoryProvider.getHistory(limit?): Promise<LLMMessage[]>` (was `ChatMessage[]`)
- `MemoryProvider.append(message: LLMMessage)` (was `ChatMessage`) — see note below
- `AgentInput.history?: LLMMessage[]` (was `ChatMessage[]`) — promotes in7's cast workaround to a first-class typed channel
- `ChatMessage` is retained where text-only is genuinely correct (transport DTOs in `adapters/src/http.ts`); the boundary converts at the edge.

`LLMMessage` (already in contracts) is the rich type:
```
LLMMessage { role: 'system'|'user'|'assistant'|'tool_result'; content: string | LLMContentBlock[] }
LLMContentBlock = text | image{data,mimeType} | tool_call{id,name,arguments} | tool_result{id,content,isError?}
```

### 2. Mapping layer (`@dongkseo/core`, new `transcript-mapping.ts`)

Pure functions, no I/O, fully unit-testable:

- `toTranscriptContent(LLMContentBlock[]) → ContentBlock[]`
  - `tool_call` → `tool_use` (`arguments`→`input`)
  - `tool_result` → `ToolResultBlock` (`id`→`tool_use_id`, `isError`→`is_error`)
  - inline `image` → `base64` source (large images delegated to `putAttachment` by the recorder, which owns the store handle)
- `toLLMMessages(TranscriptEntry[], resolveAttachment) → LLMMessage[]`
  - reverse mapping
  - resolve `attachment_ref` image sources → base64 via `TranscriptStore.getAttachment`
  - apply `SummaryTranscriptEntry.supersedesUpToUuid`: drop superseded entries, inject summary as a leading message
  - **sanitize tool pairs**: drop dangling `tool_use` with no matching `tool_result` (e.g. abort/suspend mid-tool) so the provider doesn't 400. Reuse the existing `sanitizeToolPairs` logic from `architectures/src/loop-helpers.ts` (relocate to a shared spot).

### 3. `TranscriptMemoryProvider` (`@dongkseo/core`, new)

Implements the widened `MemoryProvider`, backed by `TranscriptStore`:

- `getHistory(limit?)` → read entries → `toLLMMessages` → tail-slice by `limit`
- `append(msg)` → **no-op by default** (the recorder is the sole writer; see §4). Kept on the
  interface for compatibility, but the transcript path does not use it.
- `compact()` → summarize the text projection via the existing `TwoStageCompactor`, then write
  a `SummaryTranscriptEntry(supersedesUpToUuid = current leaf)`. `getHistory` honors it.
- `clear()` → `TranscriptStore.deleteConversation`

### 4. Runtime recorder (`@dongkseo/core`, new `transcript-recorder.ts`) — the single writer

Created per-execute inside `LocalExecutionHarness.execute()`, bound to `conversationId` +
`TranscriptStore`. **The harness is the single writer**, so architectures stop calling
`memory.append` entirely.

Fed from three sources the harness already owns:

1. **Inbound input** — `recordUserInput(input)` before the loop: a `UserTranscriptEntry`
   with the prompt text + any input images/files (attached via `putAttachment`).
2. **The `AgentEvent` stream** — in the existing `execute()` event loop. Event order per ReAct
   iteration is deterministic: `text` deltas → `tool_call`(s) → `tool_result`(s) → … → `done`.
   State machine:
   - accumulate `text` deltas;
   - on the first `tool_call`, collect consecutive `tool_call`s; on the first following
     `tool_result`, flush an `AssistantTranscriptEntry` = `[text?, tool_use...]`;
   - collect `tool_result`s (extracting images via `imageResultForLLM` → `putAttachment` →
     `attachment_ref` block), flush a `UserTranscriptEntry` = `[tool_result..., image...]`;
   - reset text; repeat;
   - on `done`, flush the final `AssistantTranscriptEntry` with `model` + `usage`.
3. **Steers** — `harness.steer()` injections (the harness owns `pendingSteers`): each becomes a
   `UserTranscriptEntry` at injection time, preserving arrival order.

`parentUuid` is chained off the recorder's running `lastUuid`. `flush()` is called in the
`execute()` `finally` block (durability boundary). All writes are best-effort: a recorder
failure is caught + logged and never crashes the turn.

### 5. Replay wiring (`@dongkseo/architectures`)

- `react.ts` L80–86: replace the `ChatMessage`→`{role,content}` mapping with
  `history.push(...await services.memory.getHistory())` and
  `history.push(...(input.history ?? []))` (both now `LLMMessage[]`).
- Remove `memory.append` calls (L91, L108, L154) — the recorder writes now. The local
  `history.push` of the current user prompt (L90) stays (needed for *this* call's LLM request).
- Resume path (L63–76) is conceptually unchanged (`architectureHistory` is already `LLMMessage[]`).
- Mirror the same edits in `plan-execute.ts`.

### 6. Store plumbing (`@dongkseo/store`, `@dongkseo/store-json`)

- `StoreProvider` (contract) + `createStoreProvider` factory do **not** currently surface
  `TranscriptStore` — add it.
- `JsonStoreProvider` / `createJsonStoreProvider` already construct everything except a
  `transcript` field — add `transcript: new TranscriptStoreJson(dataDir)`.
- `LocalExecutionHarnessOptions` / `bootstrapAgent`: pass the `TranscriptStore` so the harness
  can build the recorder and a `TranscriptMemoryProvider` as `memory`.

### 7. Shared helper relocation

`imageResultForLLM` and `sanitizeToolPairs` live in `architectures/src/loop-helpers.ts` but are
now needed by core (recorder + mapping). Relocate to a shared module core can import without a
dependency cycle (candidate: a small `@dongkseo/core` util, or `contracts` if pure).

## Error handling

- Recorder/flush failures are best-effort (catch + log), matching `TranscriptStoreJson`'s
  line-skip-on-parse-error tolerance.
- Dangling `tool_use` (suspend/abort) is handled at replay by tool-pair sanitization.
- Corrupt JSONL lines are already skipped per-line by `TranscriptStoreJson.getEntries`.

## Testing (TDD per component)

- **Mapping** unit: `LLMMessage → TranscriptEntry → LLMMessage` round-trips for text, a
  tool_use/tool_result pair, and an image (inline + attachment_ref).
- **Recorder** unit: feed event sequences (`text→tool_call→tool_result→done`; `text→done`;
  multi-tool; suspend mid-tool; steer injection) → assert entries written with correct
  `parentUuid` chain and `id` ↔ `tool_use_id` linkage.
- **Replay** unit: honors `supersedesUpToUuid`, drops dangling tool pairs, resolves
  `attachment_ref` images.
- **Integration**: ReAct loop with a mock LLM issuing a tool call across *two* executions →
  the second execution's `getHistory` returns the rich tool turns and the mock LLM observes them.

## Out of scope (YAGNI)

- Branching / `parentUuid` forks — store supports it, but we write linear chains only (Claude
  Code's default behavior).
- Subagent / sidechain transcripts.
- `@dongkseo/store-pg` `TranscriptStore` implementation — pg currently has only the text
  `ConversationStore`. A pg transcript store is a follow-up; this spec targets json + core wiring.

## Open risks

1. **store-pg divergence** — once `MemoryProvider` is rich, pg's text-only path no longer
   satisfies it. Either give pg a `TranscriptStore` impl (follow-up) or gate pg behind the old
   path until then. Confirm pg is not in this milestone's runtime.
2. **Helper cycle** — relocating `imageResultForLLM`/`sanitizeToolPairs` must not create a
   `core ↔ architectures` import cycle.
3. **AgentInput media fields** — confirm exactly how input images/files are represented on
   `AgentInput` so `recordUserInput` maps them faithfully.
