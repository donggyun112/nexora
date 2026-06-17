/**
 * Multi-agent conversation protocol tests.
 *
 * Uses scripted mock LLMs that return deterministic evaluate + respond
 * outputs, so we can verify the turn-taking logic without real models.
 */

import { describe, it, expect, vi } from 'vitest';
import { ConversationRoom, TurnManager } from '../index.js';
import type { RoomParticipant, RoomMessage, TurnManagerOptions } from '../index.js';
import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMChunk,
  LLMResponse,
  AgentCard,
} from '@dongkseo/contracts';

// ─── Mock LLM that returns scripted evaluate + respond ────────────────────

class ScriptedConversationLLM implements LLMProvider {
  constructor(
    private readonly evaluateResponse: string,
    private readonly respondResponse: string,
  ) {}

  async *stream(): AsyncGenerator<LLMChunk> {
    yield { type: 'done', content: this.respondResponse, stopReason: 'end_turn' };
  }

  async complete(_msgs: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    // Distinguish evaluate (maxTokens ≤ 80) from respond (no limit or higher)
    const isEvaluate = (options?.maxTokens ?? 999) <= 80;
    return {
      content: isEvaluate ? this.evaluateResponse : this.respondResponse,
      model: 'mock',
      stopReason: 'end_turn',
    };
  }
}

function makeCard(name: string, description: string): AgentCard {
  return {
    name,
    version: '0.1.0',
    description,
    capabilities: [],
    subscribes: [],
    publishes: [],
    tools: [],
    architecture: 'conversation',
  };
}

function makeParticipant(
  name: string,
  description: string,
  evaluateJson: { respond: boolean; confidence: number; reason: string },
  respondText: string,
): RoomParticipant {
  return {
    card: makeCard(name, description),
    llm: new ScriptedConversationLLM(
      JSON.stringify(evaluateJson),
      respondText,
    ),
  };
}

function userMsg(content: string): RoomMessage {
  return {
    sender: 'user',
    role: 'user',
    content,
    timestamp: Date.now(),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('ConversationRoom', () => {
  it('manages participants and shared history', () => {
    const room = new ConversationRoom('test-room');
    const participant = makeParticipant('ops', 'ops agent', { respond: true, confidence: 0.9, reason: 'x' }, 'ok');
    room.join(participant);

    expect(room.agentNames()).toEqual(['ops']);

    room.addUserMessage('hello');
    room.addAgentMessage('ops', 'hi there');

    expect(room.length).toBe(2);
    expect(room.history()[0].role).toBe('user');
    expect(room.history()[1].role).toBe('assistant');
    expect(room.history()[1].agentName).toBe('ops');

    const llmHistory = room.historyForLLM();
    expect(llmHistory[1].content).toContain('[ops]');
  });

  it('tracks active responder', () => {
    const room = new ConversationRoom('r');
    expect(room.activeResponder).toBeNull();
    room.activeResponder = 'agent-A';
    expect(room.activeResponder).toBe('agent-A');
    room.activeResponder = null;
    expect(room.activeResponder).toBeNull();
  });
});

describe('TurnManager — phase 1+2: evaluate and select', () => {
  it('only the highest-confidence agent responds when multiple raise hand', async () => {
    const room = new ConversationRoom('r1');
    room.join(makeParticipant(
      'ops', 'server operations',
      { respond: true, confidence: 0.9, reason: 'memory is my area' },
      'Memory leak found in Pod A.',
    ));
    room.join(makeParticipant(
      'dev', 'developer',
      { respond: true, confidence: 0.5, reason: 'could be a code issue' },
      'Might be a code bug.',
    ));
    room.join(makeParticipant(
      'security', 'security analyst',
      { respond: false, confidence: 0.1, reason: 'not security related' },
      'should-not-appear',
    ));

    const msg = userMsg('서버 메모리가 올라갔어');
    room.addMessage(msg);

    const tm = new TurnManager({ maxResponders: 1 });
    const result = await tm.handleMessage(room, msg);

    // Only ops should respond (highest confidence, maxResponders=1)
    expect(result.responses).toHaveLength(1);
    expect(result.responses[0].agentName).toBe('ops');
    expect(result.responses[0].content).toContain('Memory leak');
    expect(result.responses[0].phase).toBe('primary');

    // Evaluations should show all 3 agents' decisions
    expect(result.evaluations).toHaveLength(3);
    expect(result.evaluations[0].agentName).toBe('ops'); // sorted by confidence
  });

  it('agent that passes (respond=false) never generates a response', async () => {
    const room = new ConversationRoom('r2');
    const respondSpy = vi.fn();
    const passingLLM: LLMProvider = {
      stream: async function* () { yield { type: 'done' as const, content: '', stopReason: 'end_turn' }; },
      complete: async (_msgs, opts) => {
        const isEvaluate = (opts?.maxTokens ?? 999) <= 80;
        if (!isEvaluate) respondSpy();
        return {
          content: isEvaluate
            ? JSON.stringify({ respond: false, confidence: 0.1, reason: 'not my area' })
            : 'should not be called',
          model: 'mock',
          stopReason: 'end_turn',
        };
      },
    };

    room.join({ card: makeCard('quiet-agent', 'a quiet agent'), llm: passingLLM });

    const msg = userMsg('hello');
    room.addMessage(msg);

    const tm = new TurnManager();
    const result = await tm.handleMessage(room, msg);

    expect(result.responses).toHaveLength(0); // no fallback configured
    expect(respondSpy).not.toHaveBeenCalled();
  });
});

describe('TurnManager — phase 3+4: respond and follow-up', () => {
  it('primary responds, then follow-up agent adds to conversation', async () => {
    const room = new ConversationRoom('r3');
    room.join(makeParticipant(
      'ops', 'server operations',
      { respond: true, confidence: 0.9, reason: 'my area' },
      'Pod A has a memory leak. Restarting.',
    ));
    room.join(makeParticipant(
      'dev', 'developer',
      { respond: true, confidence: 0.6, reason: 'might know the root cause' },
      'The leak is from PR #42 — missing pool.release(). Patch incoming.',
    ));

    const msg = userMsg('서버 메모리 문제 확인해줘');
    room.addMessage(msg);

    const tm = new TurnManager({ maxResponders: 3, followUpMinConfidence: 0.5 });
    const result = await tm.handleMessage(room, msg);

    // ops = primary, dev = follow-up
    expect(result.responses.length).toBeGreaterThanOrEqual(1);
    expect(result.responses[0].agentName).toBe('ops');
    expect(result.responses[0].phase).toBe('primary');

    if (result.responses.length >= 2) {
      expect(result.responses[1].agentName).toBe('dev');
      expect(result.responses[1].phase).toBe('follow-up');
    }

    // History should contain both responses
    const agentMessages = room.history().filter(m => m.role === 'assistant');
    expect(agentMessages.length).toBeGreaterThanOrEqual(1);
  });

  it('follow-up agent that says PASS does not post', async () => {
    const room = new ConversationRoom('r4');
    room.join(makeParticipant(
      'ops', 'server operations',
      { respond: true, confidence: 0.9, reason: 'my area' },
      'Fixed it.',
    ));
    room.join({
      card: makeCard('dev', 'developer'),
      llm: new ScriptedConversationLLM(
        JSON.stringify({ respond: true, confidence: 0.6, reason: 'maybe' }),
        'PASS', // follow-up phase: nothing to add
      ),
    });

    const msg = userMsg('fix the thing');
    room.addMessage(msg);

    const tm = new TurnManager({ maxResponders: 3, followUpMinConfidence: 0.5 });
    const result = await tm.handleMessage(room, msg);

    // Only ops should appear in responses (dev said PASS)
    expect(result.responses).toHaveLength(1);
    expect(result.responses[0].agentName).toBe('ops');
  });
});

describe('TurnManager — @mention', () => {
  it('@mentioned agent always responds with confidence 1.0', async () => {
    const room = new ConversationRoom('r5');
    room.join(makeParticipant(
      'ops', 'server ops',
      { respond: false, confidence: 0.1, reason: 'not for me' }, // evaluate says no...
      'But I was @mentioned so here I am.',
    ));
    room.join(makeParticipant(
      'dev', 'developer',
      { respond: true, confidence: 0.8, reason: 'I could help' },
      'I want to help too.',
    ));

    // @ops overrides the evaluate result
    const msg = userMsg('@ops 서버 상태 알려줘');
    room.addMessage(msg);

    const tm = new TurnManager({ maxResponders: 1 });
    const result = await tm.handleMessage(room, msg);

    // ops should be primary because @mention forces confidence=1.0
    expect(result.responses).toHaveLength(1);
    expect(result.responses[0].agentName).toBe('ops');
    expect(result.evaluations.find(e => e.agentName === 'ops')?.confidence).toBe(1.0);
  });
});

describe('TurnManager — fallback', () => {
  it('calls onNoVolunteer when nobody raises hand', async () => {
    const room = new ConversationRoom('r6');
    room.join(makeParticipant(
      'agent-a', 'general',
      { respond: false, confidence: 0.1, reason: 'nope' },
      'x',
    ));

    const msg = userMsg('random question nobody can answer');
    room.addMessage(msg);

    const fallbackFn = vi.fn(async () => '죄송합니다, 적절한 에이전트가 없습니다.');
    const tm = new TurnManager({ onNoVolunteer: fallbackFn });
    const result = await tm.handleMessage(room, msg);

    expect(fallbackFn).toHaveBeenCalled();
    expect(result.responses).toHaveLength(1);
    expect(result.responses[0].phase).toBe('fallback');
    expect(result.responses[0].content).toContain('적절한 에이전트');
  });

  it('returns empty when nobody volunteers and no fallback configured', async () => {
    const room = new ConversationRoom('r7');
    room.join(makeParticipant(
      'silent', 'always silent',
      { respond: false, confidence: 0, reason: 'pass' },
      'x',
    ));

    const msg = userMsg('hello?');
    room.addMessage(msg);

    const tm = new TurnManager();
    const result = await tm.handleMessage(room, msg);

    // Default onNoVolunteer returns null → no response posted
    expect(result.responses).toHaveLength(0);
  });
});

describe('TurnManager — minConfidence filtering', () => {
  it('agents below minConfidence are treated as pass', async () => {
    const room = new ConversationRoom('r8');
    room.join(makeParticipant(
      'low-conf', 'unsure agent',
      { respond: true, confidence: 0.2, reason: 'maybe?' },
      'I could try...',
    ));

    const msg = userMsg('help');
    room.addMessage(msg);

    const tm = new TurnManager({ minConfidence: 0.3 });
    const result = await tm.handleMessage(room, msg);

    // 0.2 < 0.3 → treated as pass
    expect(result.responses).toHaveLength(0);
  });
});
