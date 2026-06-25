/**
 * Integration test: LocalExecutionHarness drives TranscriptRecorder.
 *
 * Execution 1: a tool-call turn is persisted to the store.
 * Execution 2: getHistory() on the TranscriptMemoryProvider replays it,
 *   and the stub architecture seeds history before the first LLM call —
 *   so the second LLM call receives the full rich replay.
 */
import { describe, it, expect } from 'vitest';
import type {
  AgentArchitecture,
  RuntimeServices,
  AgentInput,
  AgentEvent,
  TranscriptStore,
  TranscriptEntry,
  AttachmentRef,
  LLMMessage,
} from '@dongkseo/contracts';
import { LocalExecutionHarness } from '../execution-harness.js';
import { CoreToolExecutor } from '../tool-executor.js';
import { TranscriptMemoryProvider } from '../transcript-memory.js';
import { MockLLMProvider } from './mock-llm.js';
import type { ToolDefinition, ToolResult, ToolContext } from '@dongkseo/contracts';

// ─── fakeStore (same shape as transcript-recorder.test.ts) ───────────────────
function fakeStore(): TranscriptStore & { entries: TranscriptEntry[] } {
  const entries: TranscriptEntry[] = [];
  return {
    entries,
    appendEntry: async (e) => { entries.push(e); },
    flush: async () => {},
    async *getEntries(_id, opts) {
      const s = opts?.limit ? Math.max(0, entries.length - opts.limit) : 0;
      for (let i = s; i < entries.length; i++) yield entries[i];
    },
    putAttachment: async (): Promise<AttachmentRef> => ({ ref: 'img.png', mediaType: 'image/png', size: 3 }),
    getAttachment: async () => null,
    deleteConversation: async () => { entries.length = 0; },
  };
}

// ─── mockContext ───────────────────────────────────────────────────────────────
const mockContext: ToolContext = {
  tenantId: 'test',
  workdir: '/tmp',
  secrets: { get: async () => undefined },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

// ─── makeEcho ────────────────────────────────────────────────────────────────
function makeEcho(): ToolDefinition {
  return {
    name: 'echo',
    description: 'Echo input',
    parameters: { type: 'object', properties: { msg: { type: 'string' } } },
    execute: async (_id, input): Promise<ToolResult> => ({
      type: 'text',
      text: `echoed: ${(input as { msg: string }).msg}`,
    }),
  };
}

/**
 * Stub architecture that:
 *  1. Loads history from services.memory.getHistory() before the first LLM call.
 *  2. Calls LLM (so we can inspect callLog).
 *  3. On tool_call response: executes tool, emits events, calls LLM a second time.
 *  4. Emits done.
 *
 * Mirrors what real react.ts does — seeds history so replay works in exec 2.
 */
const historyReactArch: AgentArchitecture = {
  name: 'history-react',
  async *loop(services: RuntimeServices, input: AgentInput): AsyncGenerator<AgentEvent> {
    const history: LLMMessage[] = [];
    history.push(...await services.memory.getHistory());
    history.push({ role: 'user', content: input.prompt });

    const first = await services.llm.complete(history, { signal: services.signal });

    if (first.toolCalls && first.toolCalls.length > 0) {
      for (const tc of first.toolCalls) {
        yield { type: 'tool_call', id: tc.id, name: tc.name, input: tc.arguments };
        const result = await services.tools.execute(tc.name, tc.id, tc.arguments, services.signal);
        yield {
          type: 'tool_result',
          id: tc.id,
          name: tc.name,
          result,
          isError: (result as { type: string }).type === 'error',
        };
      }

      // Build the second-call messages (history + new turn)
      const secondHistory: LLMMessage[] = [
        ...history,
        { role: 'assistant', content: first.content },
        { role: 'user', content: 'tool ran' },
      ];
      const second = await services.llm.complete(secondHistory, { signal: services.signal });
      if (second.content) yield { type: 'text', text: second.content };
      yield { type: 'done', content: second.content, toolCalls: first.toolCalls.map(t => ({ name: t.name, input: t.arguments })) };
    } else {
      if (first.content) yield { type: 'text', text: first.content };
      yield { type: 'done', content: first.content, toolCalls: [] };
    }
  },
};

describe('LocalExecutionHarness transcript integration', () => {
  it('execution 1 persists tool turns; execution 2 replays them via getHistory', async () => {
    const store = fakeStore();
    const memory = new TranscriptMemoryProvider(store, 'conv1');
    const tools = new CoreToolExecutor({ tools: [makeEcho()], context: mockContext });

    // ── Execution 1 ──────────────────────────────────────────────────────────
    const llm1 = new MockLLMProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'echo', arguments: { msg: 'hi' } }] },
      { text: 'all done', toolCalls: [] },
    ]);
    const harness1 = new LocalExecutionHarness({
      architecture: historyReactArch,
      llm: llm1,
      tools,
      memory,
      transcript: store,
      conversationId: 'conv1',
    });

    const events1: AgentEvent[] = [];
    for await (const ev of harness1.execute({ prompt: 'echo hi' })) {
      events1.push(ev);
    }

    // Verify exec 1 event stream
    expect(events1.map(e => e.type)).toContain('tool_call');
    expect(events1.map(e => e.type)).toContain('tool_result');
    expect(events1.map(e => e.type)).toContain('done');

    // Verify store has: user, assistant(tool_use), user(tool_result), assistant(done)
    const types1 = store.entries.map(e => e.type);
    expect(types1).toContain('user');
    expect(types1).toContain('assistant');

    // Find the assistant entry with tool_use block
    const assistantWithToolUse = store.entries.find(
      e => e.type === 'assistant' &&
        (e as Extract<TranscriptEntry, { type: 'assistant' }>).content.some(b => b.type === 'tool_use'),
    ) as Extract<TranscriptEntry, { type: 'assistant' }> | undefined;
    expect(assistantWithToolUse).toBeDefined();
    const toolUseBlock = assistantWithToolUse!.content.find(b => b.type === 'tool_use');
    expect(toolUseBlock).toBeDefined();
    if (toolUseBlock?.type === 'tool_use') {
      expect(toolUseBlock.id).toBe('c1');
      expect(toolUseBlock.name).toBe('echo');
    }

    // Find the user(tool_result) entry
    const toolResultEntry = store.entries.find(
      e => e.type === 'user' &&
        (e as Extract<TranscriptEntry, { type: 'user' }>).content.some(b => b.type === 'tool_result'),
    ) as Extract<TranscriptEntry, { type: 'user' }> | undefined;
    expect(toolResultEntry).toBeDefined();
    const toolResultBlock = toolResultEntry!.content.find(b => b.type === 'tool_result');
    if (toolResultBlock?.type === 'tool_result') {
      expect(toolResultBlock.tool_use_id).toBe('c1');
    }

    // ── Execution 2 ──────────────────────────────────────────────────────────
    const llm2 = new MockLLMProvider([
      { text: 'second', toolCalls: [] },
    ]);
    const harness2 = new LocalExecutionHarness({
      architecture: historyReactArch,
      llm: llm2,
      tools,
      memory,
      transcript: store,
      conversationId: 'conv1',
    });

    const events2: AgentEvent[] = [];
    for await (const ev of harness2.execute({ prompt: 'again' })) {
      events2.push(ev);
    }

    // llm2 first call must include the replayed rich history from exec 1
    expect(llm2.callLog.length).toBeGreaterThanOrEqual(1);
    const firstCallMessages = llm2.callLog[0].messages;

    // Should contain an assistant message with a tool_call block (id c1)
    const replayedAssistant = firstCallMessages.find(
      m => m.role === 'assistant' &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string; id?: string }>).some(b => b.type === 'tool_call' && b.id === 'c1'),
    );
    expect(replayedAssistant).toBeDefined();

    // Should contain a tool_result message (id c1)
    const replayedToolResult = firstCallMessages.find(
      m => m.role === 'tool_result' &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string; id?: string }>).some(b => b.type === 'tool_result' && b.id === 'c1'),
    );
    expect(replayedToolResult).toBeDefined();
  });
});
