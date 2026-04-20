/**
 * Nexora E2E Demo — TurnManager + MeetingOrchestrator (Oracle).
 *
 * Oracle pattern: MeetingOrchestrator controls meeting turns (who speaks, when to conclude).
 * Agents have meeting tools — they open meetings themselves when needed.
 * TurnManager handles normal turn-taking. Oracle handles meeting discussion.
 */

import { defineAgent, topic } from '@nexora/contracts';
import type { MessageRouter, InboundMessage, OutboundMessage, OutboundChunk, LLMProvider } from '@nexora/contracts';
import { AnthropicProvider, OpenAIProvider, CodexProvider, FallbackLLMProvider, createProvider, AgentRunner, CoreToolExecutor } from '@nexora/core';
import { ConversationRoom, TurnManager, MeetingOrchestrator } from '@nexora/conversation';
import { MeetingManager, createMeetingTools, createReadTool, createGrepTool, createWebSearchTool, createBraveBackend } from '@nexora/tools';
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
  description: '연구, 조사, 분석, 트렌드, 브레인스토밍 전문가. 웹 검색으로 최신 정보를 찾을 수 있음.',
  architecture: 'conversation', tools: ['grep', 'web_search'],
  capabilities: ['search'], subscribes: [topic('researcher.requested')], publishes: [topic('researcher.completed')],
});
const researcher2 = defineAgent({
  name: 'researcher2', version: '0.1.0',
  description: '비평가/의심자. 다른 에이전트의 주장에서 약점, 반례, 숨겨진 가정을 찾는 역할.',
  architecture: 'conversation', tools: ['web_search'],
  capabilities: ['search'], subscribes: [topic('researcher2.requested')], publishes: [topic('researcher2.completed')],
});
const researcher3 = defineAgent({
  name: 'researcher3', version: '0.1.0',
  description: '시스템/인프라 관점 연구원. 모델 최적화, 추론 효율, 메모리 관리, 실험 설계 전문.',
  architecture: 'conversation', tools: ['web_search'],
  capabilities: ['search'], subscribes: [topic('researcher3.requested')], publishes: [topic('researcher3.completed')],
});
const assistant = defineAgent({
  name: 'assistant', version: '0.1.0',
  description: '팀 리더. 인사, 잡담, 조율, 회의 진행 담당. 회의가 필요하면 open_meeting 도구를 호출.',
  architecture: 'conversation', tools: [],
  capabilities: ['general'], subscribes: [topic('assistant.requested')], publishes: [topic('assistant.completed')],
});

// ─── 2. LLM ─────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Read Claude Code OAuth token from macOS Keychain. */
function readClaudeCodeToken(): string | undefined {
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();
    const creds = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
    };
    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken) return undefined;
    if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
      console.warn('[LLM] Claude Code OAuth token expired');
      return undefined;
    }
    return oauth.accessToken;
  } catch {
    return undefined;
  }
}

/** Read Codex (OpenAI) OAuth token from ~/.codex/auth.json */
function readCodexToken(): string | undefined {
  try {
    const authPath = process.env.CODEX_AUTH_FILE ?? join(homedir(), '.codex', 'auth.json');
    const raw = readFileSync(authPath, 'utf-8');
    const data = JSON.parse(raw) as { tokens?: { access_token?: string } };
    const token = data.tokens?.access_token;
    if (!token) return undefined;
    // Check JWT expiry
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { exp?: number };
      if (payload.exp && payload.exp * 1000 < Date.now()) {
        console.warn('[LLM] Codex OAuth token expired');
        return undefined;
      }
    } catch { /* JWT parse fail — use token anyway */ }
    return token;
  } catch {
    return undefined;
  }
}

function createLLM(): LLMProvider {
  // Priority: Codex (OpenAI) OAuth → Anthropic OAuth → API keys → mock
  const codexToken = readCodexToken();
  if (codexToken) {
    const model = process.env.CODEX_MODEL ?? 'gpt-5.4';
    console.log(`[LLM] Codex (ChatGPT OAuth) → ${model}`);
    return new FallbackLLMProvider({
      providers: [
        { name: 'codex', provider: new CodexProvider({ accessToken: codexToken, defaultModel: model }) },
        { name: 'mock', provider: new SmartMockLLM() },
      ],
      onFallback: (f, t, r) => console.log(`[LLM] ${f} → ${t}: ${r}`),
    });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  const auth = process.env.ANTHROPIC_AUTH_TOKEN ?? readClaudeCodeToken();
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

const TODAY = new Date().toISOString().slice(0, 10);
const COMMON_RULES = `
[공통 규칙]
- 오늘 날짜: ${TODAY}
- 당신은 AI 에이전트입니다. "내일", "다음에", "나중에 가져올게" 같은 지연은 금지.
- 데이터가 없으면 web_search로 지금 찾거나, 합리적 가정(assumption)을 세우고 진행하세요.
- 주장에는 반드시 근거(수치, 사례, 검색 결과)를 붙이세요. "~일 것 같다"만으로 발언하지 마세요.
- 짧고 날카롭게. 접두사([이름]:) 금지. 다른 에이전트인 척 금지.`;

const PROMPTS: Record<string, string> = {
  assistant: `당신은 assistant(팀 리더). 인사/잡담/조율/회의 진행 담당.
사용자가 "회의해", "토론하자", "미팅 열어" 등 명시적으로 회의를 요청할 때만 open_meeting을 호출하세요.
단순 질문이나 일반 대화에는 절대 회의를 열지 마세요. 직접 답하거나 다른 에이전트를 언급해 넘기세요.
participants에 ["coder","researcher","researcher2","researcher3"]을 넣으세요.${COMMON_RULES}`,
  coder: `당신은 coder(개발자). 코드/기술/구현 전문가.
회의에 초대되면 join_meeting으로 참가하고 speak으로 발언하세요.
기술적 주장에는 구체적 수치나 코드 예시를 들어 근거를 제시하세요.${COMMON_RULES}`,
  researcher: `당신은 researcher(연구원). 연구/분석 전문가. web_search 도구로 최신 정보를 검색할 수 있음.
회의에 초대되면 join_meeting으로 참가하고 speak으로 발언하세요.
주장 전에 web_search로 근거를 먼저 찾으세요. 검색 없이 추측하지 마세요.${COMMON_RULES}`,
  researcher2: `당신은 researcher2(검증자). 다른 에이전트의 주장이 정말 맞는지 검증하는 역할.
회의에 초대되면 join_meeting으로 참가하고 speak으로 발언하세요.
당신의 역할은 무조건 반대가 아니라, 근거 기반 검증입니다.
- 주장에 근거가 있으면 인정하세요. "이 부분은 근거가 탄탄하다."
- 근거가 약하거나 빠져있으면 지적하세요. "이건 ~한 경우에 깨진다", "반례: ~"
- 합의가 너무 빨리 이루어지면 놓친 관점이 없는지 확인하세요.
web_search로 반증 사례나 지지 사례를 모두 찾으세요.
검증 결과 탄탄하면 동의해도 됩니다. 억지로 반대하지 마세요.${COMMON_RULES}`,
  researcher3: `당신은 researcher3(시스템/최적화 연구원). 모델 추론 효율, 메모리 관리, KV-cache, 실험 설계 전문가.
회의에 초대되면 join_meeting으로 참가하고 speak으로 발언하세요.
이론보다 실험 가능성과 측정 방법에 집중하세요. web_search로 벤치마크를 찾으세요.${COMMON_RULES}`,
};

const meetingMgr = new MeetingManager();
const room = new ConversationRoom('nexora-chat');

// Brave Search backend (optional)
const braveKey = process.env.BRAVE_API_KEY;
const webSearchTool = braveKey
  ? createWebSearchTool(createBraveBackend({ apiKey: braveKey }))
  : null;
if (webSearchTool) console.log('[Tools] Brave Search enabled');

for (const card of [assistant, coder, researcher, researcher2, researcher3]) {
  const aliases: Record<string, string[]> = {
    assistant: ['어시스턴트', '어시', '팀장'],
    coder: ['코더', '개발자', '개발'],
    researcher: ['리서처', '연구원', '연구'],
    researcher2: ['리서처2', 'NLP연구원', 'IR연구원'],
    researcher3: ['리서처3', '시스템연구원', '최적화연구원'],
  };
  const tools = [
    ...createMeetingTools(meetingMgr, card.name),
    ...(card.tools.includes('read') ? [createReadTool()] : []),
    ...(card.tools.includes('grep') ? [createGrepTool()] : []),
    ...(card.tools.includes('web_search') && webSearchTool ? [webSearchTool] : []),
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
  const evaluatePrompt = card.name === 'coder'
    ? `You are coder — 개발자. 코드/기술 전문가.
A new message arrived. Decide if YOU should respond.
Rules:
- If the message mentions 회의/미팅/토론/meeting → respond = false (assistant handles meetings)
- If @coder or 개발자 is mentioned → respond = true, confidence = 1.0
- If the message is about code/tech/development → respond = true, confidence = 0.8
- Otherwise → respond = false
Output ONLY a JSON object: {"respond": bool, "confidence": 0.0-1.0, "reason": "one sentence"}`
    : card.name === 'researcher'
    ? `You are researcher — 연구원. 연구/분석 전문가.
A new message arrived. Decide if YOU should respond.
Rules:
- If the message mentions 회의/미팅/토론/meeting → respond = false (assistant handles meetings)
- If @researcher or 연구원 is mentioned → respond = true, confidence = 1.0
- If the message is about research/analysis/investigation → respond = true, confidence = 0.8
- Otherwise → respond = false
Output ONLY a JSON object: {"respond": bool, "confidence": 0.0-1.0, "reason": "one sentence"}`
    : card.name === 'researcher2'
    ? `You are researcher2 — 비평가/의심자. 다른 에이전트의 약점과 반례를 찾는 역할.
A new message arrived. Decide if YOU should respond.
Rules:
- If the message mentions 회의/미팅/토론/meeting → respond = false (assistant handles meetings)
- If @researcher2 or 비평 or 의심 is mentioned → respond = true, confidence = 1.0
- If other agents are making claims or reaching consensus → respond = true, confidence = 0.9
- Otherwise → respond = false
Output ONLY a JSON object: {"respond": bool, "confidence": 0.0-1.0, "reason": "one sentence"}`
    : card.name === 'researcher3'
    ? `You are researcher3 — 시스템/최적화 연구원.
A new message arrived. Decide if YOU should respond.
Rules:
- If the message mentions 회의/미팅/토론/meeting → respond = false (assistant handles meetings)
- If @researcher3 or 최적화 or 시스템 or inference is mentioned → respond = true, confidence = 1.0
- If the message is about optimization/inference/memory/benchmark → respond = true, confidence = 0.8
- Otherwise → respond = false
Output ONLY a JSON object: {"respond": bool, "confidence": 0.0-1.0, "reason": "one sentence"}`
    : card.name === 'assistant'
    ? `You are assistant — 팀 리더. 인사/잡담/조율/회의 진행 담당.

You are in a group conversation with these other agents: coder, researcher, researcher2, researcher3.

A new message just arrived. Decide if YOU should respond.

Rules:
- If the message mentions 회의/미팅/토론/meeting/논의 → respond = true, confidence = 1.0 (YOU are the ONLY one who opens meetings)
- If @assistant or 팀장 is mentioned → respond = true, confidence = 1.0
- If the message is a greeting, general chat, or unclear who should answer → respond = true, confidence = 0.9
- If the message is purely about code/tech AND coder is better suited → respond = false
- If the message is purely about research AND researcher is better suited → respond = false
- When in doubt → respond = true (you are the default responder)

Output ONLY a JSON object: {"respond": bool, "confidence": 0.0-1.0, "reason": "one sentence"}`
    : undefined;

  room.join({ card, llm, respondPrompt: PROMPTS[card.name], evaluatePrompt, aliases: aliases[card.name], runtime });
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
    // If agent opened a meeting, oracle runs the discussion
    const active = meetingMgr.listActive();
    if (active.length > 0) {
      const chunks: string[] = [];
      await orchestrator.runMeetingStream(active[0], (c) => {
        if (c.type === 'text' && c.text) chunks.push(`**${c.agent}**: ${c.text}`);
      });
      parts.push(...chunks);
    }
    return { content: parts.join('\n\n') || '(응답 없음)' };
  },

  async routeStream(msg: InboundMessage, onChunk: (c: OutboundChunk) => void): Promise<void> {
    const rmsg = room.addUserMessage(msg.content, msg.displayName);
    console.log(`[routeStream] message: "${msg.content}"`);
    const result = await tm.handleMessage(room, rmsg);
    console.log(`[routeStream] TurnManager responses: ${result.responses.map(r => r.agentName).join(', ')}`);
    for (const r of result.responses) {
      console.log(`[routeStream] emitting text for ${r.agentName}: "${r.content.slice(0, 80)}..."`);
      onChunk({ type: 'text', text: r.content, agent: r.agentName });
    }
    const active = meetingMgr.listActive();
    console.log(`[routeStream] active meetings: ${active.length}${active.length > 0 ? ` (${active[0].id})` : ''}`);
    if (active.length > 0) {
      console.log(`[routeStream] → entering runMeetingStream`);
      await orchestrator.runMeetingStream(active[0], (c) => {
        console.log(`[routeStream:SSE] type=${c.type}, agent=${'agent' in c ? c.agent : 'n/a'}${c.type === 'text' ? `, text="${(c.text ?? '').slice(0, 60)}"` : ''}`);
        onChunk(c);
      });
      console.log(`[routeStream] ← runMeetingStream done`);
    }
    onChunk({ type: 'done', content: '', agent: 'assistant' });
  },
};

// ─── 5. HTTP Server ──────────────────────────────────────────────────────

const http = new HttpAdapter({
  port: Number(process.env.PORT ?? 3001),
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
║  Agents: 🤖 assistant 💻 coder 🔍 r1 🧠 r2 ⚙️ r3     ║
║  HTTP:   http://localhost:${http.port()}                          ║
╚════════════════════════════════════════════════════════╝
`);

process.on('SIGINT', async () => { await http.stop(); process.exit(0); });
export { llm, room, tm, orchestrator, http };
