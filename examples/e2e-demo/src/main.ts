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
import { MeetingManager, createMeetingTools } from '@nexora/tools';
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
  assistant: `당신은 assistant(팀 리더)입니다. 인사/잡담/조율 담당.
회의가 필요하면 open_meeting 도구로 회의를 열 수 있습니다. 회의를 열면 당신이 마스터가 됩니다.
마스터는 conclude_meeting으로 회의를 종료합니다.
절대 다른 에이전트인 척 하지 마세요. 짧게 응답.`,
  coder: `당신은 coder(개발자)입니다. 코드/기술 전문가.
회의에 초대되면 speak 도구로 발언하고, 할 말 없으면 pass_turn합니다.
필요하면 open_thread로 다른 에이전트와 1:1 대화를 열 수 있습니다.
절대 다른 에이전트인 척 하지 마세요. 절대 [coder]: 같은 접두사를 붙이지 마세요. 짧게 응답.`,
  researcher: `당신은 researcher(연구원)입니다. 연구/분석 전문가.
회의에 초대되면 speak 도구로 발언하고, 할 말 없으면 pass_turn합니다.
필요하면 open_thread로 다른 에이전트와 1:1 대화를 열 수 있습니다.
절대 다른 에이전트인 척 하지 마세요. 절대 [researcher]: 같은 접두사를 붙이지 마세요. 짧게 응답.`,
};

// Shared meeting manager — all agents use the same instance
const meetingMgr = new MeetingManager();

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
  const master = 'assistant';

  // Master opens meeting
  const meeting = meetingMgr.open(master, userText, [...agents]);
  if (!meeting) { onChunk({ type: 'text', text: '다른 회의가 진행 중입니다.', agent: 'system' }); return; }
  onChunk({ type: 'tool_call', name: 'open_meeting', input: { topic: userText, participants: [...agents] }, agent: master });

  // Agents join
  for (const agent of agents) {
    meetingMgr.join(meeting.id, agent);
    onChunk({ type: 'tool_call', name: 'join_meeting', input: { meetingId: meeting.id }, agent });
  }

  const opening = await agentSay(master, [
    { role: 'user', content: `회의가 열렸습니다. 주제: "${userText}". 참가자: ${meeting.participants.join(', ')}. 토론을 시작하세요.` },
  ]);
  meetingMgr.speak(meeting.id, master, opening);
  onChunk({ type: 'text', text: opening, agent: master });

  // Discussion loop — master moderates each turn
  for (let round = 0; round < 10; round++) {
    const history = meetingMgr.formatHistory(meeting.id);

    // Master decides: who speaks next, or conclude?
    const moderation = await agentSay(master, [
      { role: 'user', content: `${history}\n\n---\n당신은 회의 진행자입니다. 다음 중 하나를 하세요:
1. 특정 에이전트를 지명: "NEXT: [에이전트이름] [질문이나 요청]" (예: "NEXT: coder 기술적으로 가능한가요?")
2. 회의 종료: "CONCLUDE: [최종 결론 한 줄]"
반드시 NEXT: 또는 CONCLUDE: 로 시작하세요.` },
    ]);

    if (moderation.includes('CONCLUDE')) {
      const summary = moderation.replace(/^CONCLUDE:?\s*/i, '');
      meetingMgr.speak(meeting.id, master, summary);
      meetingMgr.conclude(meeting.id, master, summary);
      onChunk({ type: 'tool_call', name: 'conclude_meeting', input: { meetingId: meeting.id }, agent: master });
      onChunk({ type: 'text', text: summary, agent: master });
      return;
    }

    // Parse NEXT: [agent] [message]
    const nextMatch = moderation.match(/^NEXT:\s*(coder|researcher)\s*(.*)/is);
    if (nextMatch) {
      const [, targetAgent, masterMsg] = nextMatch;
      // Show master's moderation message
      if (masterMsg.trim()) {
        meetingMgr.speak(meeting.id, master, masterMsg.trim());
        onChunk({ type: 'text', text: masterMsg.trim(), agent: master });
      }

      // Designated agent speaks
      const agentHistory = meetingMgr.formatHistory(meeting.id);
      const response = await agentSay(targetAgent, [
        { role: 'user', content: `${agentHistory}\n\n---\n진행자가 당신에게 발언을 요청했습니다. 응답하세요. 짧고 핵심적으로.` },
      ]);
      if (response && response !== 'PASS' && !response.includes('mock agent')) {
        meetingMgr.speak(meeting.id, targetAgent, response);
        onChunk({ type: 'text', text: response, agent: targetAgent });
      }
    } else {
      // Fallback: master said something but didn't follow format
      meetingMgr.speak(meeting.id, master, moderation);
      onChunk({ type: 'text', text: moderation, agent: master });
    }
  }
}

/**
 * Mode 3: 1:1 thread
 * Two agents open a private thread and discuss until they reach agreement.
 */
async function threadConversation(
  agentA: string,
  agentB: string,
  topicText: string,
  onChunk: (c: OutboundChunk) => void,
): Promise<void> {
  const meeting = meetingMgr.open(agentA, topicText, [agentB]);
  if (!meeting) { onChunk({ type: 'text', text: '다른 회의가 진행 중입니다.', agent: 'system' }); return; }
  onChunk({ type: 'tool_call', name: 'open_thread', input: { agent: agentB, topic: topicText }, agent: agentA });
  meetingMgr.join(meeting.id, agentB);
  onChunk({ type: 'tool_call', name: 'join_meeting', input: { meetingId: meeting.id }, agent: agentB });

  const speakers = [agentA, agentB];
  for (let turn = 0; turn < 20; turn++) {
    const speaker = speakers[turn % 2];
    const history = meetingMgr.formatHistory(meeting.id);
    const text = await agentSay(speaker, [
      { role: 'user', content: `${history}\n\n---\n대화를 이어가세요. 합의에 도달하면 "AGREED: [합의내용]"으로 시작.` },
    ]);
    if (!text || text.includes('mock agent')) break;

    if (text.includes('AGREED')) {
      const summary = text.replace(/^AGREED:?\s*/i, '');
      meetingMgr.speak(meeting.id, speaker, text);
      meetingMgr.conclude(meeting.id, agentA, summary);
      onChunk({ type: 'text', text, agent: speaker });
      onChunk({ type: 'tool_call', name: 'conclude_meeting', input: { meetingId: meeting.id }, agent: agentA });
      break;
    }

    meetingMgr.speak(meeting.id, speaker, text);
    onChunk({ type: 'text', text, agent: speaker });
  }
}

/**
 * Detect which mode to use based on user message.
 */
async function detectMode(text: string): Promise<{ mode: 1 | 2 | 3; agents?: [string, string] }> {
  // Include recent conversation history for context
  const history = room.historyForLLM().slice(-10);
  const messages: LLMMessage[] = [
    ...history,
    { role: 'user', content: text },
  ];

  const resp = await llm.complete(messages, {
      systemPrompt: `당신은 대화 모드를 결정하는 오라클입니다. 대화 맥락과 최신 메시지를 보고 JSON 하나만 출력하세요.

{"mode":1} — 사용자에게 직접 답변. 질문, 인사, 의견 요청, 각자 의견 말해달라는 요청 등.
{"mode":2} — 에이전트들끼리 자율 토론 필요. 주제 선정, 의사결정, 브레인스토밍 등. 사용자가 개입 없이 에이전트끼리 논의하라고 할 때.
{"mode":3,"agents":["A","B"]} — 특정 두 에이전트가 1:1 심층 논의. 사용자가 특정 에이전트들을 지목해서 둘이 대화하라고 할 때.

에이전트: coder(개발), researcher(연구), assistant(일반/팀리더)
JSON만 출력. 설명 금지.`,
      maxTokens: 50,
    },
  );
  try {
    const cleaned = resp.content.replace(/```json?\s*|\s*```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.mode === 3 && Array.isArray(parsed.agents)) return { mode: 3, agents: parsed.agents };
    if (parsed.mode === 2) return { mode: 2 };
  } catch { /* fallback to mode 1 */ }
  return { mode: 1 };
}

// ─── 5. Router ───────────────────────────────────────────────────────────

const router: MessageRouter = {
  async route(msg: InboundMessage): Promise<OutboundMessage> {
    const parts: string[] = [];
    const { mode } = await detectMode(msg.content);
    if (mode === 1) {
      await multiResponse(msg.content, c => { if (c.type === 'text') parts.push(`**${c.agent}**: ${c.text}`); });
    } else if (mode === 2) {
      await autonomousDiscussion(msg.content, c => { if (c.type === 'text') parts.push(`**${c.agent}**: ${c.text}`); });
    } else {
      const { agents } = await detectMode(msg.content);
      await threadConversation(agents![0], agents![1], msg.content, c => { if (c.type === 'text') parts.push(`**${c.agent}**: ${c.text}`); });
    }
    return { content: parts.join('\n\n') || '(응답 없음)' };
  },

  async routeStream(msg: InboundMessage, onChunk: (c: OutboundChunk) => void): Promise<void> {
    const detected = await detectMode(msg.content);
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
