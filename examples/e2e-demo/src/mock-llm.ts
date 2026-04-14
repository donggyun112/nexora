/**
 * Smart Mock LLM — responds based on input keywords.
 * No API key needed. For E2E testing of the full pipeline.
 */

import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMChunk,
  LLMResponse,
} from '@nexora/contracts';

export class SmartMockLLM implements LLMProvider {
  async *stream(messages: LLMMessage[], options?: LLMOptions): AsyncGenerator<LLMChunk> {
    const response = await this.complete(messages, options);
    yield { type: 'text_delta', delta: response.content };
    yield { type: 'done', content: response.content, stopReason: 'end_turn' };
  }

  async complete(messages: LLMMessage[], _options?: LLMOptions): Promise<LLMResponse> {
    const lastMessage = messages[messages.length - 1];
    const input = typeof lastMessage.content === 'string'
      ? lastMessage.content
      : JSON.stringify(lastMessage.content);

    const lower = input.toLowerCase();

    // Tool call responses
    if (lower.includes('read the file') || lower.includes('파일 읽어')) {
      return {
        content: '',
        model: 'smart-mock',
        stopReason: 'tool_use',
        toolCalls: [{
          id: `call_${Date.now()}`,
          name: 'read',
          arguments: { path: 'package.json' },
        }],
      };
    }

    if (lower.includes('search for') || lower.includes('검색')) {
      return {
        content: '',
        model: 'smart-mock',
        stopReason: 'tool_use',
        toolCalls: [{
          id: `call_${Date.now()}`,
          name: 'grep',
          arguments: { pattern: 'nexora', path: '.' },
        }],
      };
    }

    // Direct responses
    if (lower.includes('hello') || lower.includes('안녕')) {
      return reply('Hello! I\'m a Nexora agent. I can read files, search code, and help with your project. What would you like to do?');
    }

    if (lower.includes('who are you') || lower.includes('누구')) {
      return reply('I\'m an AI agent running on the Nexora framework. I have access to tools like read, grep, and exec. I work as part of a team of specialized agents.');
    }

    if (lower.includes('help') || lower.includes('도움')) {
      return reply('I can help with:\n- Reading and analyzing files\n- Searching code\n- Answering questions about your project\n\nJust tell me what you need!');
    }

    if (lower.includes('delegate') || lower.includes('위임')) {
      return reply('I would delegate this to a specialized agent with the right capability. The delegation system finds agents by what they can do, not by name.');
    }

    if (lower.includes('what tools') || lower.includes('도구')) {
      return reply('My available tools are: read (file reading), grep (code search). I can use these to explore and understand your codebase.');
    }

    // Default
    return reply(`I received your message: "${input.slice(0, 100)}". I'm a mock agent for E2E testing — in production, this would be powered by Claude or GPT.`);
  }
}

function reply(content: string): LLMResponse {
  return { content, model: 'smart-mock', stopReason: 'end_turn' };
}
