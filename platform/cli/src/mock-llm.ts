/**
 * Deterministic, keyless mock LLM for `nexora test-serve`.
 *
 * Keyword-driven so a coding assistant can drive predictable e2e flows —
 * including tool execution — without an API key. Mirrors the proven
 * examples/e2e-demo SmartMockLLM, but self-contained (no @dongkseo/contracts
 * import) so the dependency-free CLI can ship and unit-test it directly.
 */

interface MockMessage {
  role: string;
  content: unknown;
}
interface MockToolCall {
  id: string;
  name: string;
  arguments: unknown;
}
export interface MockLLMResponse {
  content: string;
  model: string;
  stopReason: string;
  toolCalls?: MockToolCall[];
}

export class SmartMockLLM {
  async *stream(messages: MockMessage[], options?: { systemPrompt?: string }): AsyncGenerator<unknown> {
    const r = await this.complete(messages, options);
    if (r.toolCalls && r.toolCalls.length > 0) {
      // streamLlm assembles tool calls from tool_call_start + tool_call_delta
      // chunks (it ignores any toolCalls on the `done` chunk).
      for (const tc of r.toolCalls) {
        yield { type: 'tool_call_start', id: tc.id, name: tc.name };
        yield { type: 'tool_call_delta', id: tc.id, delta: JSON.stringify(tc.arguments) };
      }
      yield { type: 'done', content: r.content, stopReason: 'tool_use' };
      return;
    }
    yield { type: 'text_delta', delta: r.content };
    yield { type: 'done', content: r.content, stopReason: 'end_turn' };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async complete(messages: MockMessage[], options?: { systemPrompt?: string }): Promise<MockLLMResponse> {
    const sys = options?.systemPrompt ?? '';

    // TurnManager evaluate phase ("should you respond?") — always opt in so the
    // pipeline produces a response for the assistant to assert on.
    if (sys.includes('"respond"')) {
      return reply(JSON.stringify({ respond: true, confidence: 0.9, reason: 'mock: respond to drive e2e' }));
    }
    // TurnManager follow-up phase.
    if (sys.includes('output exactly: PASS')) {
      return reply('PASS');
    }

    // Once a tool has run, finalize — guarantees the ReAct loop terminates and
    // never re-issues a tool call in a loop.
    if (messages.some((m) => m.role === 'tool_result')) {
      return reply('Tool executed — returning the final answer. (mock)');
    }

    const last = messages[messages.length - 1];
    const input = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    const lower = input.toLowerCase();

    if (lower.includes('read the file') || lower.includes('파일 읽')) {
      return toolCall('read', { path: 'package.json' });
    }
    if (lower.includes('search for') || lower.includes('grep') || lower.includes('검색')) {
      return toolCall('grep', { pattern: 'nexora', path: '.' });
    }
    if (lower.includes('hello') || lower.includes('안녕')) {
      return reply('Hello! I am a Nexora mock agent for e2e testing. Try "read the file" or "search for X".');
    }
    if (lower.includes('who are you') || lower.includes('누구')) {
      return reply('I am test-agent, a deterministic mock running on the Nexora framework (no API key).');
    }
    return reply(`echo: "${input.slice(0, 200)}"`);
  }
}

function reply(content: string): MockLLMResponse {
  return { content, model: 'smart-mock', stopReason: 'end_turn' };
}
function toolCall(name: string, args: unknown): MockLLMResponse {
  return { content: '', model: 'smart-mock', stopReason: 'tool_use', toolCalls: [{ id: `call_${name}`, name, arguments: args }] };
}
