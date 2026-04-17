/**
 * Nexora E2E Demo — TurnManager + AgentRunner + Meeting Tools.
 *
 * No oracle. All messages go through TurnManager.
 * Agents have meeting tools — they open meetings themselves when needed.
 * TurnManager handles turn-taking. AgentRunner enables tool calling.
 */

import { defineAgent, topic } from '@nexora/contracts';
import type { MessageRouter, InboundMessage, OutboundMessage, OutboundChunk, LLMProvider, LLMMessage } from '@nexora/contracts';
import { AnthropicProvider, FallbackLLMProvider, createProvider, AgentRunner, CoreToolExecutor } from '@nexora/core';
import { ConversationRoom, TurnManager, MeetingOrchestrator } from '@nexora/conversation';
import { MeetingManager, createMeetingTools, createReadTool, createGrepTool } from '@nexora/tools';
import { createReactArchitecture } from '@nexora/architectures';
import { HttpAdapter } from '@nexora/adapters';
import { SmartMockLLM } from './mock-llm.js';

// ─── 1. Agents ──────────────────────────────────────────────────────────

const coder = defineAgent({
  name: 'coder', version: '0.1.0',
  description: '코드, 기술, 개발, 아키텍처, 디버깅 전문가.',
  architecture: 'conversation', tools: ['read', 'grep'],
  capabilities: ['code-reading'], subscribes: [topic('coder.requested')], publishes: [topic('coder.completed')],
});
const researcher = defineAgent({
  name: 'researcher', version: '0.1.0',
  description: '연구, 조사, 분석, 트렌드, 브레인스토밍 전문가.',
  architecture: 'conversation', tools: ['grep'],
  capabilities: ['search'], subscribes: [topic('researcher.requested')], publishes: [topic('researcher.completed')],
});
const assistant = defineAgent({
  name: 'assistant', version: '0.1.0',
  description: '팀 리더. 인사, 잡담, 조율, 회의 진행 담당. 회의가 필요하면 open_meeting 도구를 호출.',
  architecture: 'conversation', tools: [],
  capabilities: ['general'], subscribes: [topic('assistant.requested')], publishes: [topic('assistant.completed')],
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
  console.log('[LLM] mock');
  return new SmartMockLLM();
}
const llm = createLLM();

// ─── 3. Room with AgentRunners (agents can use tools) ────────────────────

const PROMPTS: Record<string, string> = {
  assistant: `당신은 assistant(팀 리더). 인사/잡담/조율/회의 진행 담당.
회의/토론/미팅 요청이 오면 즉시 open_meeting 도구를 호출하세요. participants에 ["coder","researcher"]만 넣으세요. 다른 이름(designer, pm 등)은 넣지 마세요.
회의 중에는 주제에 대한 당신의 의견만 말하세요.
절대 다른 에이전트(coder, researcher)의 말을 대신 쓰지 마세요. [coder]: 나 [researcher]: 같은 형식으로 다른 에이전트인 척 하지 마세요.
짧게 응답.`,
  coder: `당신은 coder(개발자). 코드/기술 전문가.
회의에 초대되면 join_meeting으로 참가하고 speak으로 발언하세요.
절대 다른 에이전트인 척 하지 마세요. [coder]: 접두사 금지. 짧게.`,
  researcher: `당신은 researcher(연구원). 연구/분석 전문가.
회의에 초대되면 join_meeting으로 참가하고 speak으로 발언하세요.
절대 다른 에이전트인 척 하지 마세요. [researcher]: 접두사 금지. 짧게.`,
};

const meetingMgr = new MeetingManager();
const room = new ConversationRoom('nexora-chat');

for (const card of [assistant, coder, researcher]) {
  const aliases: Record<string, string[]> = {
    assistant: ['어시스턴트', '어시', '팀장'],
    coder: ['코더', '개발자', '개발'],
    researcher: ['리서처', '연구원', '연구'],
  };
  const tools = [
    ...createMeetingTools(meetingMgr, card.name),
    ...(card.tools.includes('read') ? [createReadTool()] : []),
    ...(card.tools.includes('grep') ? [createGrepTool()] : []),
  ];

  // Runtime uses base LLM — ReAct dynamically passes tools via LLMOptions
  const runtime = new AgentRunner({
    architecture: createReactArchitecture({ systemPrompt: PROMPTS[card.name], maxIterations: 5 }),
    llm,
    tools: new CoreToolExecutor({
      tools,
      context: { tenantId: 'default', workdir: process.cwd(), secrets: { get: async () => undefined }, logger: { info: () => {}, warn: () => {}, error: () => {} } },
    }),
  });
  room.join({ card, llm, respondPrompt: PROMPTS[card.name], aliases: aliases[card.name], runtime });
}

const tm = new TurnManager({
  maxResponders: 3, minConfidence: 0.3, followUpMinConfidence: 0.4,
  onBeforeRespond: (name, phase) => console.log(`[Turn] ${name} (${phase})`),
});

const orchestrator = new MeetingOrchestrator(room, meetingMgr);

// ─── 4. Router — TurnManager + auto meeting orchestration ───────────────

const router: MessageRouter = {
  async route(msg: InboundMessage): Promise<OutboundMessage> {
    const rmsg = room.addUserMessage(msg.content, msg.displayName);
    const result = await tm.handleMessage(room, rmsg);
    const parts = result.responses.map(r => `**${r.agentName}**: ${r.content}`);
    // If agent opened a meeting, run the meeting loop
    const active = meetingMgr.listActive();
    if (active.length > 0) {
      const m = active[0];
      const others = m.invited.length > 0 ? m.invited : m.participants.filter((p: string) => p !== m.master);
      const summary = await orchestrator.runMeeting(m.master, m.topic, others);
      if (summary) parts.push(`**${m.master}**: ${summary}`);
    }
    return { content: parts.join('\n\n') || '(응답 없음)' };
  },

  async routeStream(msg: InboundMessage, onChunk: (c: OutboundChunk) => void): Promise<void> {
    const rmsg = room.addUserMessage(msg.content, msg.displayName);
    const result = await tm.handleMessage(room, rmsg);
    for (const r of result.responses) {
      onChunk({ type: 'text', text: r.content, agent: r.agentName });
    }
    // If agent opened a meeting, orchestrator streams the meeting
    const active = meetingMgr.listActive();
    if (active.length > 0) {
      const m = active[0];
      // Meeting already opened by agent's tool call — just run the discussion loop
      orchestrator.onEvent(onChunk);
      // Join participants that haven't joined yet
      for (const inv of m.invited) {
        if (!room.getParticipant(inv)) continue; // skip unknown agents
        meetingMgr.join(m.id, inv);
        onChunk({ type: 'tool_call', name: 'join_meeting', input: { meetingId: m.id }, agent: inv });
      }

      // Discussion via AgentRunner — agents use speak/pass_turn tools
      // checkAvailability hides open_meeting during active meeting
      let silentRounds = 0;
      for (let round = 0; round < 10; round++) {
        const mHistory = meetingMgr.formatHistory(m.id);
        const prompt = round === 0
          ? `${mHistory}\n\nspeak 도구를 사용해서 위 주제에 대한 의견을 말하세요.`
          : `${mHistory}\n\n이전 발언에 대해 speak 도구로 반응하세요. 할 말 없으면 pass_turn 도구를 호출하세요.`;

        let anySpoke = false;
        for (const agentName of m.participants as string[]) {
          const p = room.getParticipant(agentName);
          if (!p?.runtime) continue;

          for await (const ev of p.runtime.execute({ prompt })) {
            if (ev.type === 'tool_call') {
              onChunk({ type: 'tool_call', name: ev.name, input: ev.input as Record<string,unknown>, agent: agentName });
              if (ev.name === 'speak') anySpoke = true;
            }
            if (ev.type === 'tool_result' && ev.name === 'speak') {
              const last = meetingMgr.get(m.id)?.messages.at(-1);
              if (last?.agent === agentName) {
                room.addAgentMessage(agentName, last.content);
                onChunk({ type: 'text', text: last.content, agent: agentName });
              }
            }
          }
        }

        if (!anySpoke) { silentRounds++; if (silentRounds >= 2) break; }
        else silentRounds = 0;

        // Master checks conclude every 3 rounds
        if (round > 0 && round % 3 === 0) {
          const mp = room.getParticipant(m.master);
          if (mp) {
            const check = await mp.llm.complete(
              [{ role: 'user', content: meetingMgr.formatHistory(m.id) + '\n\n합의 시 "CONCLUDE: [결론]". 아니면 "CONTINUE".' }] as LLMMessage[],
              { systemPrompt: '회의 진행자.', maxTokens: 200 },
            );
            if (check.content?.includes('CONCLUDE')) {
              const summary = check.content.replace(/^CONCLUDE:?\s*/i, '');
              meetingMgr.speak(m.id, m.master, summary);
              meetingMgr.conclude(m.id, m.master, summary);
              room.addAgentMessage(m.master, summary);
              onChunk({ type: 'text', text: summary, agent: m.master });
              onChunk({ type: 'tool_call', name: 'conclude_meeting', input: { meetingId: m.id }, agent: m.master });
              break;
            }
          }
        }
      }
      if (meetingMgr.get(m.id)?.status === 'active') {
        meetingMgr.conclude(m.id, m.master, '회의 종료');
        onChunk({ type: 'tool_call', name: 'conclude_meeting', input: { meetingId: m.id }, agent: m.master });
      }
    }
    onChunk({ type: 'done', content: '', agent: 'assistant' });
  },
};

// ─── 5. HTTP Server ──────────────────────────────────────────────────────

const http = new HttpAdapter({
  port: Number(process.env.PORT ?? 3000),
  host: '0.0.0.0',
  resolveTenant: () => 'default',
});
await http.start(router);

console.log(`
╔════════════════════════════════════════════════════════╗
║  Nexora — TurnManager + Meeting Tools                  ║
║                                                        ║
║  All messages → TurnManager → AgentRunner (with tools) ║
║  Agents call open_meeting/speak/conclude themselves    ║
║                                                        ║
║  Agents: 🤖 assistant  💻 coder  🔍 researcher        ║
║  HTTP:   http://localhost:${http.port()}                          ║
╚════════════════════════════════════════════════════════╝
`);

process.on('SIGINT', async () => { await http.stop(); process.exit(0); });
export { llm, room, tm, orchestrator, http };
