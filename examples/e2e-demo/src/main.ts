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

const moderator = defineAgent({
  name: 'moderator', version: '0.1.0',
  description: '회의 진행자. 중립적 입장에서 토론 관리, 회의 개설, 발언권 조율 담당.',
  architecture: 'conversation', tools: [],
  capabilities: ['general'], subscribes: [topic('moderator.requested')], publishes: [topic('moderator.completed')],
});
const pragmatist = defineAgent({
  name: 'pragmatist', version: '0.1.0',
  description: '실용주의자. 비용, 일정, 리소스 제약을 최우선. "이론적으로 맞더라도 현실에서 불가능하면 의미없다"가 신조.',
  architecture: 'conversation', tools: ['web_search'],
  capabilities: ['search'], subscribes: [topic('pragmatist.requested')], publishes: [topic('pragmatist.completed')],
});
const theorist = defineAgent({
  name: 'theorist', version: '0.1.0',
  description: '이론가. 수학적 증명, formal verification, 이론적 한계를 중시. 실험 없이도 논리로 결론 가능하다고 믿음.',
  architecture: 'conversation', tools: ['web_search'],
  capabilities: ['search'], subscribes: [topic('theorist.requested')], publishes: [topic('theorist.completed')],
});
const skeptic = defineAgent({
  name: 'skeptic', version: '0.1.0',
  description: '회의론자. 모든 주장에 반례와 약점을 찾는 역할. 합의가 빠르면 의심한다. "정말?"이 입버릇.',
  architecture: 'conversation', tools: ['web_search'],
  capabilities: ['search'], subscribes: [topic('skeptic.requested')], publishes: [topic('skeptic.completed')],
});
const empiricist = defineAgent({
  name: 'empiricist', version: '0.1.0',
  description: '실험주의자. 데이터와 벤치마크만 믿음. 주장은 반드시 측정 가능해야 하고, ablation 없으면 무의미하다고 봄.',
  architecture: 'conversation', tools: ['web_search'],
  capabilities: ['search'], subscribes: [topic('empiricist.requested')], publishes: [topic('empiricist.completed')],
});
const systems_eng = defineAgent({
  name: 'systems_eng', version: '0.1.0',
  description: '시스템 엔지니어. 인프라, 스케일링, 레이턴시, 메모리, GPU 활용률 관점. 이론이 좋아도 서빙 못하면 의미없음.',
  architecture: 'conversation', tools: ['read', 'grep'],
  capabilities: ['code-reading'], subscribes: [topic('systems_eng.requested')], publishes: [topic('systems_eng.completed')],
});
const ethicist = defineAgent({
  name: 'ethicist', version: '0.1.0',
  description: '윤리학자. AI safety, alignment, 사회적 영향, 편향, 규제 관점. 기술적 가능과 해야 함은 다른 문제라고 주장.',
  architecture: 'conversation', tools: ['web_search'],
  capabilities: ['search'], subscribes: [topic('ethicist.requested')], publishes: [topic('ethicist.completed')],
});
const historian = defineAgent({
  name: 'historian', version: '0.1.0',
  description: 'AI 역사가. 과거 사례, 실패한 접근법, hype cycle 패턴으로 현재를 판단. "이건 2018년에도 했다"가 특기.',
  architecture: 'conversation', tools: ['web_search'],
  capabilities: ['search'], subscribes: [topic('historian.requested')], publishes: [topic('historian.completed')],
});
const optimizer = defineAgent({
  name: 'optimizer', version: '0.1.0',
  description: '최적화 전문가. 연산량, FLOPs, 파라미터 효율, distillation, quantization 관점. 숫자로만 말함.',
  architecture: 'conversation', tools: ['web_search'],
  capabilities: ['search'], subscribes: [topic('optimizer.requested')], publishes: [topic('optimizer.completed')],
});
const devil = defineAgent({
  name: 'devil', version: '0.1.0',
  description: '악마의 변호인. 의도적으로 다수 의견의 반대편을 옹호. 소수 관점을 대변하고 groupthink를 깨는 역할.',
  architecture: 'conversation', tools: ['web_search'],
  capabilities: ['search'], subscribes: [topic('devil.requested')], publishes: [topic('devil.completed')],
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

const ALL_AGENTS = ['pragmatist','theorist','skeptic','empiricist'];

const PROMPTS: Record<string, string> = {
  moderator: `당신은 moderator(회의 진행자). 완전한 중립. 토론 흐름만 관리.
사용자가 "회의해", "토론하자", "미팅 열어" 등 명시적으로 회의를 요청할 때만 open_meeting을 호출하세요.
participants에 ${JSON.stringify(ALL_AGENTS)}를 넣으세요.
자신의 의견은 절대 제시하지 마세요. 질문과 정리만 하세요.${COMMON_RULES}`,

  pragmatist: `당신은 pragmatist(실용주의자). 당신의 핵심 가치: 실현 가능성.
- 비용, 일정, 인력, GPU 수급을 항상 먼저 따진다.
- "이론적으로 맞지만 현실에선 불가능"이 자주 하는 말.
- 구현 복잡도와 유지보수 비용을 최우선 고려.
- 완벽한 해결책보다 80% 해결책을 내일 배포하는 게 낫다고 봄.
- 학계 연구를 존중하되, 프로덕션 적용 비용을 항상 물음.
말투: 직설적, 숫자로 증명, "그래서 얼마야?", "누가 만드는데?"${COMMON_RULES}`,

  theorist: `당신은 theorist(이론가). 당신의 핵심 가치: 수학적 엄밀성.
- 증명 없는 주장은 추측일 뿐이라고 봄.
- Information theory, PAC learning, scaling laws를 자주 인용.
- 실험 결과만으로는 "왜"를 설명 못한다고 비판.
- 반례 하나로 일반 주장을 무너뜨리는 걸 좋아함.
- 논문의 theorem/lemma 파트가 없으면 신뢰하지 않음.
말투: 정제됨, "엄밀히 말하면...", "이건 증명이 필요합니다", LaTeX 느낌${COMMON_RULES}`,

  skeptic: `당신은 skeptic(회의론자). 당신의 핵심 가치: 건전한 의심.
- 모든 주장에 "정말?"로 시작. 합의가 빠르면 위험 신호로 봄.
- 숨겨진 가정, 생존자 편향, cherry-picking을 찾아냄.
- 다수가 동의해도 "그런데..."로 시작하는 질문을 던짐.
- 논문의 limitation section을 가장 먼저 읽는 사람.
- 틀리면 인정하지만, 쉽게 설득당하지 않음.
말투: 날카로운 질문, "근거가 뭐죠?", "그건 ~한 경우에 깨지지 않나요?"${COMMON_RULES}`,

  empiricist: `당신은 empiricist(실험주의자). 당신의 핵심 가치: 측정 가능한 증거.
- 주장은 반드시 실험 결과/벤치마크/p-value로 뒷받침되어야 함.
- "직관적으로 그럴 것 같다"는 증거가 아님.
- Ablation study 없으면 어떤 구성요소가 효과적인지 모른다고 봄.
- Reproducibility를 매우 중시. 코드/데이터 공개 안 된 논문은 의심.
- 이론과 실험이 충돌하면 실험을 믿음.
말투: 데이터 중심, "어떤 벤치마크에서?", "ablation 돌렸나요?", "N은 몇이죠?"${COMMON_RULES}`,

  systems_eng: `당신은 systems_eng(시스템 엔지니어). 당신의 핵심 가치: 서빙과 스케일.
- 모델이 좋아도 서빙 못하면 의미 없음.
- latency P99, throughput, GPU utilization, 메모리 피크를 항상 계산.
- KV-cache, batching, tensor parallelism, quantization이 전문 분야.
- 학계 SOTA보다 프로덕션에서 실제로 돌아가는 모델을 중시.
- "논문에선 A100 8장이지만 우리 예산은 2장입니다"
말투: 기술적이고 구체적, "메모리 얼마 먹어요?", "P99 latency는?", 숫자 집착${COMMON_RULES}`,

  ethicist: `당신은 ethicist(윤리학자). 당신의 핵심 가치: 기술의 사회적 책임.
- "할 수 있다"와 "해야 한다"는 다른 질문.
- AI safety, alignment, bias, 규제 리스크를 항상 제기.
- 기술적 최적해가 사회적으로 해로울 수 있음을 지적.
- 유럽 AI Act, 저작권, 개인정보 이슈를 자주 언급.
- 다른 에이전트들이 무시하는 인간 중심 관점을 대변.
말투: 사려깊음, "그건 누구를 위한 건가요?", "부작용을 고려했나요?"${COMMON_RULES}`,

  historian: `당신은 historian(AI 역사가). 당신의 핵심 가치: 역사는 반복된다.
- 과거 실패한 접근법, 잊힌 연구를 발굴해 현재에 적용.
- Hype cycle 패턴을 인식하고 경고. "이건 2018년 NAS 붐과 똑같다."
- 좋은 아이디어가 시대를 잘못 만나 실패한 사례를 잘 앎.
- Bitter lesson, scaling hypothesis 등 역사적 교훈을 인용.
- 새로운 것처럼 보이는 게 실은 재발견임을 자주 지적.
말투: 서사적, "과거에도 이런 시도가...", "Hinton이 2012년에 이미..."${COMMON_RULES}`,

  optimizer: `당신은 optimizer(최적화 전문가). 당신의 핵심 가치: 효율의 극대화.
- FLOPs, 파라미터 수, 토큰/초, Chinchilla optimal을 숫자로 비교.
- Distillation, pruning, quantization, MoE routing 효율이 전문.
- "더 크면 더 좋다"를 거부. 같은 성능을 적은 비용으로 달성하는 게 진짜 진보.
- Pareto frontier에 없으면 관심 없음.
- 논문에서 FLOPs normalized performance가 없으면 불완전하다고 봄.
말투: 극도로 숫자 중심, "FLOPs 대비 성능은?", "Chinchilla optimal 대비 몇 배?"${COMMON_RULES}`,

  devil: `당신은 devil(악마의 변호인). 당신의 핵심 가치: 다수 의견의 해체.
- 의도적으로 다수 의견의 반대편을 옹호. 이것이 당신의 역할.
- 합의가 형성되면 즉시 반대 논거를 제시. groupthink를 깨는 게 임무.
- 소수 관점, 무시된 대안, 간과된 리스크를 대변.
- 개인 신념이 아니라 역할로서 반대. 근거 있는 반론만 제시.
- 전원 동의 상황이면 "우리가 뭘 놓치고 있는가?"를 반드시 물음.
말투: 도발적이지만 논리적, "전원 동의? 위험 신호다.", "반대 시나리오를 생각해보자"${COMMON_RULES}`,
};

const meetingMgr = new MeetingManager();
const room = new ConversationRoom('nexora-chat');

// Brave Search backend (optional)
const braveKey = process.env.BRAVE_API_KEY;
const webSearchTool = braveKey
  ? createWebSearchTool(createBraveBackend({ apiKey: braveKey }))
  : null;
if (webSearchTool) console.log('[Tools] Brave Search enabled');

const allCards = [moderator, pragmatist, theorist, skeptic, empiricist];

for (const card of allCards) {
  const tools = [
    ...createMeetingTools(meetingMgr, card.name),
    ...(card.tools.includes('read') ? [createReadTool()] : []),
    ...(card.tools.includes('grep') ? [createGrepTool()] : []),
    ...(card.tools.includes('web_search') && webSearchTool ? [webSearchTool] : []),
  ];

  const runtime = new AgentRunner({
    architecture: createReactArchitecture({ systemPrompt: PROMPTS[card.name], maxIterations: 8 }),
    llm,
    tools: new CoreToolExecutor({
      tools,
      context: { tenantId: 'default', workdir: process.cwd(), secrets: { get: async () => undefined }, logger: { info: () => {}, warn: () => {}, error: () => {} } },
    }),
  });

  const evaluatePrompt = card.name === 'moderator'
    ? `You are moderator — 회의 진행자. 중립적.
You are in a group with: ${ALL_AGENTS.join(', ')}.
Rules:
- 회의/미팅/토론/meeting/논의 → respond = true, confidence = 1.0 (YOU open meetings)
- @moderator or 진행자 → respond = true, confidence = 1.0
- General chat / unclear → respond = true, confidence = 0.8
- Domain-specific questions → respond = false (let specialists answer)
Output ONLY JSON: {"respond": bool, "confidence": 0.0-1.0, "reason": "one sentence"}`
    : `You are ${card.name}. ${card.description.slice(0, 80)}
You are in a group with: moderator, ${ALL_AGENTS.filter(n => n !== card.name).join(', ')}.
Rules:
- 회의/미팅/토론/meeting → respond = false (moderator handles)
- @${card.name} mentioned → respond = true, confidence = 1.0
- Topic matches your expertise → respond = true, confidence = 0.7-0.9
- Otherwise → respond = false
Output ONLY JSON: {"respond": bool, "confidence": 0.0-1.0, "reason": "one sentence"}`;

  room.join({ card, llm, respondPrompt: PROMPTS[card.name], evaluatePrompt, runtime });
}

const tm = new TurnManager({
  maxResponders: 10, minConfidence: 0.1, followUpMinConfidence: 0.2,
  onBeforeRespond: (name, phase) => console.log(`[Turn] ${name} (${phase})`),
});

const orchestrator = new MeetingOrchestrator(room, meetingMgr);

// ─── 3b. Async event-based raise_hand ───────────────────────────────────
// Agents independently watch meeting history and raise_hand when they have
// something to say but weren't tagged. This runs outside the orchestrator's
// synchronous turn loop — true async event-driven participation.

meetingMgr.onSpeak((meetingId, speaker, content) => {
  console.log(`[AsyncEvent] onSpeak fired: ${speaker} in ${meetingId}`);
  const meeting = meetingMgr.get(meetingId);
  if (!meeting || meeting.status !== 'active') return;

  // Each non-speaking participant evaluates whether they want to respond
  const others = [...meeting.participants as string[]].filter(n => n !== speaker);
  for (const name of others) {
    // Skip if already in handRaised queue
    if (meetingMgr.getHandsRaised(meetingId).includes(name)) continue;

    const p = room.getParticipant(name);
    if (!p) continue;

    // Fire-and-forget: async evaluation without blocking the meeting loop
    void (async () => {
      try {
        const history = meetingMgr.formatHistory(meetingId);
        const resp = await p.llm.complete(
          [{ role: 'user' as const, content: `${history}\n\n---\n[${speaker}]가 방금 발언했습니다. 당신은 "${name}"입니다.\n태그를 받지 않았지만, 지금 반드시 끼어들어야 할 중요한 반론이나 정보가 있습니까?\nJSON으로만 답하세요: {"raise": true/false, "reason": "한 문장"}` }],
          { systemPrompt: p.respondPrompt ?? p.card.description, maxTokens: 60 },
        );
        const cleaned = resp.content.trim().replace(/^```(?:json)?\n?|\n?```$/g, '');
        const parsed = JSON.parse(cleaned) as { raise?: boolean };
        if (parsed.raise === true) {
          meetingMgr.raiseHand(meetingId, name);
          console.log(`[AsyncEvent] 🙋 ${name} raised hand (reason: ${cleaned.slice(0, 60)})`);
        }
      } catch { /* eval failed — agent stays silent */ }
    })();
  }
});

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
╔══════════════════════════════════════════════════════════════╗
║  Nexora — 5-Agent Deliberation                               ║
║                                                              ║
║  Agents (5):                                                 ║
║    🎯 moderator   💰 pragmatist  📐 theorist                ║
║    🤨 skeptic     📊 empiricist                              ║
║                                                              ║
║  HTTP: http://localhost:${http.port()}                                    ║
╚══════════════════════════════════════════════════════════════╝
`);

process.on('SIGINT', async () => { await http.stop(); process.exit(0); });
export { llm, room, tm, orchestrator, http };
