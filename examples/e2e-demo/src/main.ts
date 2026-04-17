/**
 * Nexora E2E Demo — multi-agent group chat.
 *
 * 3 agents in a ConversationRoom. TurnManager decides who speaks.
 * Like a Discord channel where agents are members.
 *
 * Run:
 *   pnpm build && cd examples/e2e-demo && pnpm start
 *   Open http://localhost:3000
 */

import { defineAgent, topic } from '@nexora/contracts';
import type { MessageRouter, InboundMessage, OutboundMessage, OutboundChunk } from '@nexora/contracts';
import { AnthropicProvider, FallbackLLMProvider, createProvider } from '@nexora/core';
import { ConversationRoom } from '@nexora/conversation';
import { HttpAdapter } from '@nexora/adapters';
import { SmartMockLLM } from './mock-llm.js';

import type { LLMProvider } from '@nexora/contracts';

// ─── 1. Agents ──────────────────────────────────────────────────────────

const coder = defineAgent({
  name: 'coder',
  version: '0.1.0',
  description: '코드, 기술, 개발, 프로젝트 구조, 아키텍처, 디버깅 전문가. 코드나 기술 관련 모든 질문에 응답. 연구주제 논의에도 기술 관점으로 참여.',
  architecture: 'conversation',
  tools: ['read', 'grep'],
  capabilities: ['code-reading', 'file-analysis'],
  subscribes: [topic('coder.requested')],
  publishes: [topic('coder.completed')],
});

const researcher = defineAgent({
  name: 'researcher',
  version: '0.1.0',
  description: '연구, 조사, 분석, 주제 선정, 트렌드, 비교 전문가. 연구주제, 아이디어, 브레인스토밍 관련 모든 질문에 응답.',
  architecture: 'conversation',
  tools: ['grep'],
  capabilities: ['search', 'research'],
  subscribes: [topic('researcher.requested')],
  publishes: [topic('researcher.completed')],
});

const assistant = defineAgent({
  name: 'assistant',
  version: '0.1.0',
  description: '인사, 잡담만 담당. 코드/기술/연구/분석 질문에는 절대 응답하지 않음. 다른 에이전트 이름이 언급되면 양보.',
  architecture: 'conversation',
  tools: ['read', 'grep'],
  capabilities: ['general', 'routing'],
  subscribes: [topic('assistant.requested')],
  publishes: [topic('assistant.completed')],
});

// ─── 2. LLM ─────────────────────────────────────────────────────────────

function createLLM(): LLMProvider {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const anthropicAuth = process.env.ANTHROPIC_AUTH_TOKEN;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  if (anthropicKey || anthropicAuth) {
    console.log('[LLM] Using Anthropic (claude-haiku-4-5)', anthropicAuth ? '(OAuth)' : '(API key)');
    return new FallbackLLMProvider({
      providers: [
        { name: 'anthropic', provider: new AnthropicProvider({ apiKey: anthropicKey, authToken: anthropicAuth, defaultModel: 'claude-haiku-4-5-20251001' }) },
        { name: 'mock', provider: new SmartMockLLM() },
      ],
      onFallback: (from, to, reason) => console.log(`[LLM] ${from} → ${to}: ${reason}`),
    });
  }
  if (openrouterKey) {
    console.log('[LLM] Using OpenRouter');
    return createProvider('openrouter', { apiKey: openrouterKey });
  }
  console.log('[LLM] No API key — using mock LLM');
  return new SmartMockLLM();
}

const llm = createLLM();

// ─── 3. Conversation Room — all agents in one channel ────────────────────

const room = new ConversationRoom('nexora-chat');

room.join({
  card: assistant,
  llm,
  respondPrompt: `당신은 assistant입니다. 팀 리더로서 일반적인 질문, 인사, 잡담에 응답합니다.
중요: 절대로 다른 에이전트(coder, researcher)인 척 하지 마세요. 당신은 assistant만 됩니다.
기술적 질문은 다른 에이전트가 답할 것이니 양보하세요. 항상 사용자의 언어로 응답하세요.`,
});

room.join({
  card: coder,
  llm,
  respondPrompt: `당신은 coder입니다. 코드 분석, 개발, 디버깅 전문가입니다.
절대 다른 에이전트(researcher, assistant)의 말을 대신 쓰지 마세요. 당신의 의견만 말하세요.
다른 에이전트가 이미 말한 내용이 보이면 그것에 대해 당신의 관점으로 반응하세요.
항상 사용자의 언어로 짧고 핵심적으로 응답하세요.`,
});

room.join({
  card: researcher,
  llm,
  respondPrompt: `당신은 researcher입니다. 연구, 조사, 분석 전문가입니다.
절대 다른 에이전트(coder, assistant)의 말을 대신 쓰지 마세요. 당신의 의견만 말하세요.
다른 에이전트가 이미 말한 내용이 보이면 그것에 대해 당신의 관점으로 반응하세요.
항상 사용자의 언어로 짧고 핵심적으로 응답하세요.`,
});

// ─── 4. Router — streams each agent's response as separate SSE chunks ────

// ─── 4. Router — natural conversation: only agents with something to say respond

const AGENT_NAMES = ['coder', 'researcher', 'assistant'] as const;

/** Ask an agent if they want to respond. Returns null if they pass. */
async function askToRespond(agentName: string): Promise<string | null> {
  const p = room.getParticipant(agentName);
  if (!p) return null;

  const history = room.historyForLLM();
  const sysPrompt = `${p.respondPrompt ?? p.card.description}

규칙:
1. 이 대화에서 당신의 전문 분야와 직접 관련된 내용이 있을 때만 응답하세요.
2. 인사, 잡담, 일반 질문은 assistant만 답합니다. coder와 researcher는 PASS하세요.
3. 이미 다른 에이전트가 충분히 답한 내용은 PASS하세요.
4. 할 말이 없으면 반드시 "PASS" 한 단어만 출력하세요. 다른 텍스트를 추가하지 마세요.
5. 절대 다른 에이전트인 척 하지 마세요.`;

  const response = await p.llm.complete(
    history as import('@nexora/contracts').LLMMessage[],
    { systemPrompt: sysPrompt, maxTokens: 512 },
  );

  const text = response.content.trim();
  // Generous PASS detection — LLM may wrap it in brackets, prefix with name, etc.
  const normalized = text.replace(/^\[.*?\]:\s*/g, '').replace(/^---\s*/g, '').trim();
  if (!normalized || /^PASS$/i.test(normalized) || normalized.startsWith('PASS') || text.includes('mock agent for E2E')) return null;
  // Filter out responses that are just other agents saying PASS
  if (/^\[.*?\]:\s*PASS/m.test(text) && !text.replace(/\[.*?\]:\s*PASS\s*/g, '').trim()) return null;

  room.addAgentMessage(agentName, text);
  return text;
}

const router: MessageRouter = {
  async route(msg: InboundMessage): Promise<OutboundMessage> {
    room.addUserMessage(msg.content, msg.displayName);
    const parts: string[] = [];
    for (let round = 0; round < 4; round++) {
      let anySpoke = false;
      for (const name of AGENT_NAMES) {
        const text = await askToRespond(name);
        if (text) { parts.push(`**${name}**: ${text}`); anySpoke = true; }
      }
      if (!anySpoke) break;
    }
    return { content: parts.join('\n\n') || '(응답 없음)' };
  },

  async routeStream(msg: InboundMessage, onChunk: (c: OutboundChunk) => void): Promise<void> {
    room.addUserMessage(msg.content, msg.displayName);

    for (let round = 0; round < 4; round++) {
      let anySpoke = false;
      for (const name of AGENT_NAMES) {
        const text = await askToRespond(name);
        if (text) {
          onChunk({ type: 'text', text, agent: name });
          anySpoke = true;
        }
      }
      if (!anySpoke) break;
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
║  Nexora — Multi-Agent Group Chat                       ║
║                                                        ║
║  Agents: 🤖 assistant  💻 coder  🔍 researcher        ║
║  HTTP:   http://localhost:${http.port()}                          ║
║  UI:     http://localhost:5173 (run pnpm dev in web-ui)║
║                                                        ║
║  TurnManager decides who speaks based on relevance.    ║
║  Multiple agents can respond to the same message.      ║
║                                                        ║
║  Press Ctrl+C to stop.                                 ║
╚════════════════════════════════════════════════════════╝
`);

process.on('SIGINT', async () => {
  await http.stop();
  process.exit(0);
});

export { llm, room, http };
