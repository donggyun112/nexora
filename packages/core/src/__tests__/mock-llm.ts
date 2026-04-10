/**
 * Mock LLM Provider — 테스트용.
 *
 * 미리 정의된 응답을 순차적으로 반환.
 */

import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMChunk,
  LLMResponse,
} from '@nexora/contracts';

export interface MockResponse {
  /** 최종 텍스트 */
  text: string;
  /** 도구 호출 (선택) */
  toolCalls?: { id: string; name: string; arguments: unknown }[];
  /** 요청 시 던질 에러 (선택) */
  throwError?: string;
}

export class MockLLMProvider implements LLMProvider {
  private readonly responses: MockResponse[];
  private index = 0;
  public readonly callLog: { messages: LLMMessage[]; options?: LLMOptions }[] = [];

  constructor(responses: MockResponse[]) {
    this.responses = responses;
  }

  reset(): void {
    this.index = 0;
    this.callLog.length = 0;
  }

  private next(): MockResponse {
    if (this.index >= this.responses.length) {
      throw new Error(`MockLLMProvider exhausted (called ${this.index + 1} times, only ${this.responses.length} responses)`);
    }
    return this.responses[this.index++];
  }

  async *stream(messages: LLMMessage[], options?: LLMOptions): AsyncGenerator<LLMChunk> {
    this.callLog.push({ messages, options });
    const r = this.next();
    if (r.throwError) throw new Error(r.throwError);

    if (r.text) yield { type: 'text_delta', delta: r.text };

    for (const tc of r.toolCalls ?? []) {
      yield { type: 'tool_call_start', id: tc.id, name: tc.name };
      yield { type: 'tool_call_delta', id: tc.id, delta: JSON.stringify(tc.arguments) };
    }

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
