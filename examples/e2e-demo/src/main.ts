/**
 * Nexora E2E Demo — Oracle with MeetingOrchestrator.
 *
 * 3 conversation modes, all powered by framework-level components:
 * - ConversationRoom + TurnManager (Mode 1: multi-response)
 * - MeetingOrchestrator.runMeeting (Mode 2: autonomous discussion)
 * - MeetingOrchestrator.runThread (Mode 3: 1:1 thread)
 *
 * Run: pnpm build && cd examples/e2e-demo && pnpm start
 */

import { defineAgent, topic } from '@nexora/contracts';
import type { MessageRouter, InboundMessage, OutboundMessage, OutboundChunk, LLMProvider, LLMMessage } from '@nexora/contracts';
import { AnthropicProvider, FallbackLLMProvider, createProvider } from '@nexora/core';
import { ConversationRoom, TurnManager, MeetingOrchestrator } from '@nexora/conversation';
import { MeetingManager } from '@nexora/tools';
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
  description: '팀 리더. 인사, 잡담, 조율 담당. 기술/연구 질문은 양보.',
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
  const or = process.env.OPENROUTER_API_KEY;
  if (or) return createProvider('openrouter', { apiKey: or });
  console.log('[LLM] mock');
  return new SmartMockLLM();
}
const llm = createLLM();

// ─── 3. Room + Orchestrator (framework level) ────────────────────────────

const PROMPTS: Record<string, string> = {
  assistant: '당신은 assistant(팀 리더). 인사/잡담/조율 담당. 회의 진행자 역할. 절대 다른 에이전트인 척 하지 마세요. 짧게.',
  coder: '당신은 coder(개발자). 코드/기술 전문가. 절대 다른 에이전트인 척 하지 마세요. [coder]: 접두사 금지. 짧게.',
  researcher: '당신은 researcher(연구원). 연구/분석 전문가. 절대 다른 에이전트인 척 하지 마세요. [researcher]: 접두사 금지. 짧게.',
};

const room = new ConversationRoom('nexora-chat');
for (const card of [assistant, coder, researcher]) {
  room.join({ card, llm, respondPrompt: PROMPTS[card.name] });
}

const tm = new TurnManager({
  maxResponders: 3, minConfidence: 0.3, followUpMinConfidence: 0.4,
  onBeforeRespond: (name, phase) => console.log(`[Turn] ${name} (${phase})`),
});

const meetingMgr = new MeetingManager();
const orchestrator = new MeetingOrchestrator(room, meetingMgr);

// ─── 4. Oracle (LLM-based mode detection) ────────────────────────────────

async function detectMode(text: string): Promise<{ mode: 1 | 2 | 3; agents?: [string, string] }> {
  const history = room.historyForLLM().slice(-10);
  const resp = await llm.complete(
    [...history, { role: 'user', content: text }] as LLMMessage[],
    {
      systemPrompt: `대화 모드 오라클. JSON만 출력.
{"mode":1} — 직접 답변 (질문, 인사, 의견 요청)
{"mode":2} — 에이전트 자율 토론 (주제 선정, 의사결정, 브레인스토밍)
{"mode":3,"agents":["A","B"]} — 1:1 심층 논의 (A,B는 coder/researcher/assistant)
JSON만. 설명 금지.`,
      maxTokens: 50,
    },
  );
  try {
    const parsed = JSON.parse(resp.content.replace(/```json?\s*|\s*```/g, '').trim());
    if (parsed.mode === 3 && Array.isArray(parsed.agents)) return { mode: 3, agents: parsed.agents };
    if (parsed.mode === 2) return { mode: 2 };
  } catch { /* mode 1 */ }
  return { mode: 1 };
}

// ─── 5. Router ───────────────────────────────────────────────────────────

const router: MessageRouter = {
  async route(msg: InboundMessage): Promise<OutboundMessage> {
    const parts: string[] = [];
    const collect = (c: OutboundChunk) => { if (c.type === 'text' && c.text) parts.push(`**${c.agent}**: ${c.text}`); };
    const { mode, agents } = await detectMode(msg.content);
    if (mode === 2) {
      orchestrator.onEvent(collect);
      await orchestrator.runMeeting('assistant', msg.content, ['coder', 'researcher']);
    } else if (mode === 3 && agents) {
      orchestrator.onEvent(collect);
      await orchestrator.runThread(agents[0], agents[1], msg.content);
    } else {
      const rmsg = room.addUserMessage(msg.content, msg.displayName);
      const result = await tm.handleMessage(room, rmsg);
      for (const r of result.responses) parts.push(`**${r.agentName}**: ${r.content}`);
    }
    return { content: parts.join('\n\n') || '(응답 없음)' };
  },

  async routeStream(msg: InboundMessage, onChunk: (c: OutboundChunk) => void): Promise<void> {
    const { mode, agents } = await detectMode(msg.content);
    console.log(`[Oracle] mode=${mode}`, agents || '');

    if (mode === 2) {
      orchestrator.onEvent(onChunk);
      await orchestrator.runMeeting('assistant', msg.content, ['coder', 'researcher']);
    } else if (mode === 3 && agents) {
      orchestrator.onEvent(onChunk);
      await orchestrator.runThread(agents[0], agents[1], msg.content);
    } else {
      // Mode 1: TurnManager
      const rmsg = room.addUserMessage(msg.content, msg.displayName);
      const result = await tm.handleMessage(room, rmsg);
      for (const r of result.responses) {
        onChunk({ type: 'text', text: r.content, agent: r.agentName });
      }
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
║  Nexora Oracle — Framework-Level Meeting System        ║
║                                                        ║
║  Mode 1: Multi-response (TurnManager)                  ║
║  Mode 2: Meeting (MeetingOrchestrator.runMeeting)      ║
║  Mode 3: Thread (MeetingOrchestrator.runThread)         ║
║                                                        ║
║  Agents: 🤖 assistant  💻 coder  🔍 researcher        ║
║  HTTP:   http://localhost:${http.port()}                          ║
╚════════════════════════════════════════════════════════╝
`);

process.on('SIGINT', async () => { await http.stop(); process.exit(0); });
export { llm, room, tm, orchestrator, http };
