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

  async complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const lastMessage = messages[messages.length - 1];
    const input = typeof lastMessage.content === 'string'
      ? lastMessage.content
      : JSON.stringify(lastMessage.content);

    const lower = input.toLowerCase();

    // Evaluate phase — TurnManager asks "should you respond?"
    const sys = options?.systemPrompt ?? '';
    if (sys.includes('Output ONLY a JSON object') && sys.includes('"respond"')) {
      return this.handleEvaluate(sys, lower);
    }

    // Follow-up phase — TurnManager asks "anything to add?"
    if (sys.includes('output exactly: PASS')) {
      return reply('PASS');
    }

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

  // ─── Evaluate handler ─────────────────────────────────────────────
  private handleEvaluate(systemPrompt: string, inputLower: string): LLMResponse {
    // Extract agent name from system prompt: "You are {name} —"
    const nameMatch = systemPrompt.match(/^You are (\w+)/);
    const name = nameMatch?.[1] ?? '';

    // assistant handles greetings and general chat
    if (name === 'assistant') {
      return reply(JSON.stringify({ respond: true, confidence: 0.9, reason: 'I am the team leader and should respond to general messages' }));
    }

    // coder responds to code/tech topics
    if (name === 'coder' && /코드|code|기술|tech|개발|dev|버그|bug|구현|impl/.test(inputLower)) {
      return reply(JSON.stringify({ respond: true, confidence: 0.8, reason: 'This is a technical question in my domain' }));
    }

    // researcher responds to research/analysis topics
    if (name === 'researcher' && /연구|research|분석|analy|조사|트렌드|trend/.test(inputLower)) {
      return reply(JSON.stringify({ respond: true, confidence: 0.8, reason: 'This is a research question in my domain' }));
    }

    // Meeting-related — everyone should participate
    if (/회의|미팅|meeting|토론|discuss/.test(inputLower)) {
      return reply(JSON.stringify({ respond: true, confidence: 0.85, reason: 'Meeting request — I should participate' }));
    }

    // Default: don't respond
    return reply(JSON.stringify({ respond: false, confidence: 0.1, reason: 'Not my area of expertise' }));
  }
}

function reply(content: string): LLMResponse {
  return { content, model: 'smart-mock', stopReason: 'end_turn' };
}
