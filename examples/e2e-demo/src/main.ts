/**
 * Nexora E2E Demo — Oracle: 3 conversation modes.
 *
 * Mode 1: Multi-response — multiple agents respond to user message
 * Mode 2: Autonomous discussion — turnmaster moderates, agents discuss, turnmaster ends
 * Mode 3: 1:1 thread — two agents open a private thread and talk
 *
 * Run:
 *   pnpm build && cd examples/e2e-demo && pnpm start
 *   Open http://localhost:3000
 */

import { defineAgent, topic } from '@nexora/contracts';
import type { MessageRouter, InboundMessage, OutboundMessage, OutboundChunk, LLMProvider, LLMMessage } from '@nexora/contracts';
import { AnthropicProvider, FallbackLLMProvider, createProvider } from '@nexora/core';
import { ConversationRoom, TurnManager } from '@nexora/conversation';
import { HttpAdapter } from '@nexora/adapters';
import { SmartMockLLM } from './mock-llm.js';

// ─── 1. Agents ──────────────────────────────────────────────────────────

const coder = defineAgent({
  name: 'coder', version: '0.1.0',
  description: '코드, 기술, 개발, 아키텍처, 디버깅 전문가.',
  architecture: 'conversation', tools: ['read', 'grep'],
  capabilities: ['code-reading', 'file-analysis'],
  subscribes: [topic('coder.requested')], publishes: [topic('coder.completed')],
});

const researcher = defineAgent({
  name: 'researcher', version: '0.1.0',
  description: '연구, 조사, 분석, 트렌드, 브레인스토밍 전문가.',
  architecture: 'conversation', tools: ['grep'],
  capabilities: ['search', 'research'],
  subscribes: [topic('researcher.requested')], publishes: [topic('researcher.completed')],
});

const assistant = defineAgent({
  name: 'assistant', version: '0.1.0',
  description: '팀 리더. 인사, 잡담, 조율 담당. 기술/연구 질문은 양보.',
  architecture: 'conversation', tools: ['read', 'grep'],
  capabilities: ['general', 'routing'],
  subscribes: [topic('assistant.requested')], publishes: [topic('assistant.completed')],
});

// ─── 2. LLM ─────────────────────────────────────────────────────────────

function createLLM(): LLMProvider {
  const key = process.env.ANTHROPIC_API_KEY;
  const auth = process.env.ANTHROPIC_AUTH_TOKEN;
  if (key || auth) {
    console.log('[LLM] Anthropic', auth ? '(OAuth)' : '(API key)');
    return new FallbackLLMProvider({
      providers: [
        { name: 'anthropic', provider: new AnthropicProvider({ apiKey: key, authToken: auth, defaultModel: 'claude-haiku-4-5-20251001' }) },
        { name: 'mock', provider: new SmartMockLLM() },
      ],
      onFallback: (f, t, r) => console.log(`[LLM] ${f} → ${t}: ${r}`),
    });
  }
  const or = process.env.OPENROUTER_API_KEY;
  if (or) return createProvider('openrouter', { apiKey: or });
  console.log('[LLM] mock');
  return new SmartMockLLM();
}

const llm = createLLM();

const PROMPTS: Record<string, string> = {
  assistant: '당신은 assistant(팀 리더)입니다. 인사/잡담/조율만 담당. 기술/연구는 양보. 절대 다른 에이전트인 척 하지 마세요. 짧게 응답.',
  coder: '당신은 coder(개발자)입니다. 코드/기술 전문가. 절대 다른 에이전트인 척 하지 마세요. 짧게 응답.',
  researcher: '당신은 researcher(연구원)입니다. 연구/분석 전문가. 절대 다른 에이전트인 척 하지 마세요. 짧게 응답.',
};

// ─── 3. Conversation Room ────────────────────────────────────────────────

const room = new ConversationRoom('nexora-chat');
for (const card of [assistant, coder, researcher]) {
  room.join({ card, llm, respondPrompt: PROMPTS[card.name] });
}

const tm = new TurnManager({
  maxResponders: 3,
  minConfidence: 0.3,
  followUpMinConfidence: 0.4,
  onBeforeRespond: (name, phase) => console.log(`[Turn] ${name} (${phase})`),
});

// ─── 4. Oracle: 3 conversation modes ────────────────────────────────────

/** Helper: call LLM for a specific agent with conversation context */
async function agentSay(agentName: string, messages: LLMMessage[]): Promise<string> {
  const resp = await llm.complete(messages, {
    systemPrompt: PROMPTS[agentName],
    maxTokens: 300,
  });
  return resp.content.trim();
}

/**
 * Mode 1: Multi-response
 * TurnManager evaluates all agents, relevant ones respond simultaneously.
 */
async function multiResponse(
  userText: string,
  onChunk: (c: OutboundChunk) => void,
): Promise<void> {
  const msg = room.addUserMessage(userText);
  const result = await tm.handleMessage(room, msg);
  for (const r of result.responses) {
    onChunk({ type: 'text', text: r.content, agent: r.agentName });
  }
  if (result.responses.length === 0) {
    onChunk({ type: 'text', text: '(아무도 응답하지 않았습니다)', agent: 'assistant' });
  }
}

/**
 * Mode 2: Autonomous discussion
 * Turnmaster (assistant) moderates. Agents discuss freely.
 * Turnmaster decides when to end.
 */
async function autonomousDiscussion(
  userText: string,
  onChunk: (c: OutboundChunk) => void,
): Promise<void> {
  const agents = ['coder', 'researcher'] as const;
  const turnmaster = 'assistant';
  const history: LLMMessage[] = [{ role: 'user', content: userText }];

  // Turnmaster opens the discussion
  const opening = await agentSay(turnmaster, [
    { role: 'user', content: `사용자가 "${userText}"라고 요청했습니다. 당신은 턴마스터입니다. coder와 researcher에게 이 주제에 대해 각자 의견을 말하라고 지시하세요. 짧게.` },
  ]);
  history.push({ role: 'assistant', content: `[${turnmaster}]: ${opening}` });
  room.addAgentMessage(turnmaster, opening);
  onChunk({ type: 'text', text: opening, agent: turnmaster });

  // Discussion loop — runs until turnmaster says CONCLUDE
  for (let round = 0; round < 10; round++) {
    // Each agent gets a turn
    for (const agent of agents) {
      const text = await agentSay(agent, [
        ...history,
        { role: 'user', content: `대화를 이어가세요. 이전 발언에 반응하고, 새로운 관점을 추가하세요. 동의하면 동의한다고, 반대하면 반대 이유를 말하세요. 할 말이 정말 없으면 "PASS".` },
      ]);
      if (!text || text === 'PASS' || text.includes('mock agent')) continue;
      history.push({ role: 'assistant', content: `[${agent}]: ${text}` });
      room.addAgentMessage(agent, text);
      onChunk({ type: 'text', text, agent });
    }

    // Turnmaster evaluates: enough discussion or need more?
    const decision = await agentSay(turnmaster, [
      ...history,
      { role: 'user', content: `당신은 턴마스터입니다. 지금까지의 토론을 평가하세요.
- 합의에 도달했거나 충분히 논의되었으면: "CONCLUDE"로 시작하고 최종 결론을 정리하세요.
- 아직 더 논의가 필요하면: "CONTINUE"로 시작하고 다음에 논의할 포인트를 제시하세요.
- 특정 에이전트에게 추가 의견을 요청할 수도 있습니다.` },
    ]);
    history.push({ role: 'assistant', content: `[${turnmaster}]: ${decision}` });
    room.addAgentMessage(turnmaster, decision);
    onChunk({ type: 'text', text: decision, agent: turnmaster });

    if (decision.includes('CONCLUDE')) break;
  }
}

/**
 * Mode 3: 1:1 thread
 * Two agents open a private thread and discuss until they reach agreement.
 */
async function threadConversation(
  agentA: string,
  agentB: string,
  topic: string,
  onChunk: (c: OutboundChunk) => void,
): Promise<void> {
  const history: LLMMessage[] = [
    { role: 'user', content: `주제: "${topic}". ${agentA}와 ${agentB}가 1:1로 논의합니다. 합의에 도달하면 "AGREED"로 시작하세요.` },
  ];

  const speakers = [agentA, agentB];
  for (let turn = 0; turn < 20; turn++) {
    const speaker = speakers[turn % 2];
    const text = await agentSay(speaker, history);
    if (!text || text.includes('mock agent')) break;
    history.push({ role: 'assistant', content: `[${speaker}]: ${text}` });
    room.addAgentMessage(speaker, text);
    onChunk({ type: 'text', text, agent: speaker });

    if (text.startsWith('AGREED') || text.includes('AGREED')) break;
  }
}

/**
 * Detect which mode to use based on user message.
 */
function detectMode(text: string): { mode: 1 | 2 | 3; agents?: [string, string]; topic?: string } {
  const lower = text.toLowerCase();

  // Mode 3: explicit 1:1 thread request
  const threadMatch = lower.match(/(coder|researcher|assistant)\s*(?:와|랑|하고)\s*(coder|researcher|assistant)/);
  if (threadMatch && (lower.includes('둘이') || lower.includes('1:1') || lower.includes('스레드') || lower.includes('따로'))) {
    return { mode: 3, agents: [threadMatch[1], threadMatch[2]], topic: text };
  }

  // Mode 1 override: "각각", "각자" = individual responses, not discussion
  if (lower.includes('각각') || lower.includes('각자') || lower.includes('회의없이') || lower.includes('회의 없이')) {
    return { mode: 1 };
  }

  // Mode 2: discussion/debate request
  if (lower.includes('토론') || lower.includes('논의') || lower.includes('회의') ||
      lower.includes('정해') || lower.includes('결정') || lower.includes('브레인스토밍') ||
      (lower.includes('끼리') && lower.includes('대화')) ||
      (lower.includes('이야기') && (lower.includes('해서') || lower.includes('해봐')))) {
    return { mode: 2 };
  }

  // Mode 1: default — multi-response
  return { mode: 1 };
}

// ─── 5. Router ───────────────────────────────────────────────────────────

const router: MessageRouter = {
  async route(msg: InboundMessage): Promise<OutboundMessage> {
    const parts: string[] = [];
    const { mode } = detectMode(msg.content);
    if (mode === 1) {
      await multiResponse(msg.content, c => { if (c.type === 'text') parts.push(`**${c.agent}**: ${c.text}`); });
    } else if (mode === 2) {
      await autonomousDiscussion(msg.content, c => { if (c.type === 'text') parts.push(`**${c.agent}**: ${c.text}`); });
    } else {
      const { agents } = detectMode(msg.content);
      await threadConversation(agents![0], agents![1], msg.content, c => { if (c.type === 'text') parts.push(`**${c.agent}**: ${c.text}`); });
    }
    return { content: parts.join('\n\n') || '(응답 없음)' };
  },

  async routeStream(msg: InboundMessage, onChunk: (c: OutboundChunk) => void): Promise<void> {
    const detected = detectMode(msg.content);
    console.log(`[Oracle] mode=${detected.mode}`, detected.agents || '');

    if (detected.mode === 1) {
      await multiResponse(msg.content, onChunk);
    } else if (detected.mode === 2) {
      await autonomousDiscussion(msg.content, onChunk);
    } else {
      await threadConversation(detected.agents![0], detected.agents![1], msg.content, onChunk);
    }

    onChunk({ type: 'done', content: '', agent: 'assistant' });
  },
};

// ─── 6. HTTP Server ──────────────────────────────────────────────────────

const http = new HttpAdapter({
  port: Number(process.env.PORT ?? 3000),
  host: '0.0.0.0',
  resolveTenant: () => 'default',
});

await http.start(router);

console.log(`
╔════════════════════════════════════════════════════════╗
║  Nexora Oracle — 3 Conversation Modes                  ║
║                                                        ║
║  Mode 1: Multi-response (default)                      ║
║    "안녕" → relevant agents respond                     ║
║                                                        ║
║  Mode 2: Autonomous discussion                         ║
║    "연구주제 정해봐" → agents discuss, turnmaster ends   ║
║                                                        ║
║  Mode 3: 1:1 Thread                                    ║
║    "coder랑 researcher 둘이 논의해봐" → private thread   ║
║                                                        ║
║  Agents: 🤖 assistant  💻 coder  🔍 researcher        ║
║  HTTP:   http://localhost:${http.port()}                          ║
╚════════════════════════════════════════════════════════╝
`);

process.on('SIGINT', async () => {
  await http.stop();
  process.exit(0);
});

export { llm, room, tm, http };
