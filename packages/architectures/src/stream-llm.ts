import type { AgentEvent, LLMChunk, LLMResponse } from '@dongkseo/contracts';

/**
 * Drive an LLM chunk stream to completion, yielding incremental `text`/`thinking`
 * AgentEvents as deltas arrive and returning the assembled `LLMResponse` for the
 * loop's tool-call / termination logic.
 *
 * Architectures call this via `const res = yield* streamLlm(llm.stream(...))`:
 * `yield*` forwards the delta events to the transport (so output streams token by
 * token) while the generator's return value carries the full content + toolCalls
 * + usage the loop still needs. Replaces the prior `await llm.complete(...)`, which
 * buffered the whole turn and emitted one `text` event at the end.
 */
export async function* streamLlm(
  stream: AsyncGenerator<LLMChunk>,
  model: string,
): AsyncGenerator<AgentEvent, LLMResponse> {
  let content = '';
  let thinking = '';
  const order: string[] = [];
  const toolCallsById = new Map<string, { id: string; name: string; argsJson: string }>();
  let stopReason = 'end_turn';
  let usage: LLMResponse['usage'];

  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text_delta':
        if (!chunk.delta) break;
        content += chunk.delta;
        yield { type: 'text', text: chunk.delta };
        break;
      case 'thinking_delta':
        if (!chunk.delta) break;
        thinking += chunk.delta;
        yield { type: 'thinking', content: chunk.delta };
        break;
      case 'tool_call_start':
        if (!toolCallsById.has(chunk.id)) {
          toolCallsById.set(chunk.id, { id: chunk.id, name: chunk.name, argsJson: '' });
          order.push(chunk.id);
        }
        break;
      case 'tool_call_delta': {
        const tc = toolCallsById.get(chunk.id);
        if (tc) tc.argsJson += chunk.delta;
        break;
      }
      case 'done':
        // done.content is the provider's authoritative full text; prefer it over
        // accumulated deltas (a snapshot-style provider may not emit text_delta).
        if (chunk.content) content = chunk.content;
        stopReason = chunk.stopReason;
        usage = chunk.usage;
        break;
    }
  }

  const toolCalls = order.map((id) => {
    const tc = toolCallsById.get(id)!;
    return { id: tc.id, name: tc.name, arguments: parseToolArgs(tc.argsJson) };
  });

  return {
    content,
    thinking: thinking || undefined,
    model,
    stopReason,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
  };
}

// Tool arguments stream as raw JSON fragments; the concatenation is complete and
// parseable once `done` arrives. Fall back to an empty object on malformed JSON
// so a single bad tool call degrades to no-args rather than crashing the turn.
function parseToolArgs(json: string): unknown {
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
