/**
 * Mock LLM Provider — 테스트용 (architectures 패키지 로컬).
 *
 * core 패키지의 mock과 동일하지만 패키지 간 의존을 피하려고 복사.
 */

import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMChunk,
  LLMResponse,
  RuntimeServices,
} from '@nexora/contracts';

export interface MockResponse {
  text: string;
  toolCalls?: { id: string; name: string; arguments: unknown }[];
  throwError?: string;
}

export class MockLLMProvider implements LLMProvider {
  private readonly responses: MockResponse[];
  private index = 0;
  public readonly callLog: { messages: LLMMessage[]; options?: LLMOptions }[] = [];

  constructor(responses: MockResponse[]) {
    this.responses = responses;
  }

  private next(): MockResponse {
    if (this.index >= this.responses.length) {
      throw new Error(`MockLLMProvider exhausted (called ${this.index + 1} times)`);
    }
    return this.responses[this.index++];
  }

  async *stream(messages: LLMMessage[], options?: LLMOptions): AsyncGenerator<LLMChunk> {
    this.callLog.push({ messages, options });
    const r = this.next();
    if (r.throwError) throw new Error(r.throwError);
    if (r.text) yield { type: 'text_delta', delta: r.text };
    yield { type: 'done', content: r.text, stopReason: r.toolCalls?.length ? 'tool_use' : 'end_turn' };
  }

  async complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    this.callLog.push({ messages, options });
    const r = this.next();
    if (r.throwError) throw new Error(r.throwError);
    return {
      content: r.text,
      model: 'mock',
      stopReason: r.toolCalls?.length ? 'tool_use' : 'end_turn',
      toolCalls: r.toolCalls,
    };
  }
}

export function makeServices(
  llm: LLMProvider,
  tools: Map<string, (input: unknown) => Promise<unknown>>,
  overridesOrSignal?: AbortSignal | Partial<RuntimeServices>,
) {
  const signal = overridesOrSignal instanceof AbortSignal
    ? overridesOrSignal
    : new AbortController().signal;
  const overrides = overridesOrSignal instanceof AbortSignal || overridesOrSignal === undefined
    ? {}
    : overridesOrSignal;

  const base = {
    llm,
    tools: {
      execute: async (name: string, _id: string, input: unknown) => {
        const fn = tools.get(name);
        if (!fn) return { type: 'error' as const, message: `unknown tool: ${name}` };
        return fn(input);
      },
      list: () => Array.from(tools.keys()).map(name => ({
        name,
        description: name,
        parameters: {},
      })),
    },
    memory: {
      append: async () => {},
      getHistory: async () => [],
      compact: async () => null,
      clear: async () => {},
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    signal,
  };

  return { ...base, ...overrides };
}
