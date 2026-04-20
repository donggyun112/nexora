/**
 * MeetingOrchestrator — ReplyGroup-based meeting loop.
 *
 * Core concept: when agent A tags [B, C, D], a ReplyGroup is created.
 * ALL callees must respond before any other action (master check, evaluate, new tags).
 * Master moderation uses a separate moderator persona, not the participant persona.
 */

import type { AgentRuntime, AgentInput, LLMMessage, OutboundChunk } from '@nexora/contracts';
import { ConversationRoom } from './room.js';
import { TurnManager } from './turn-manager.js';
import type { MeetingManager, Meeting } from '@nexora/tools';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Types ──────────────────────────────────────────────────────────────

export interface MeetingEvent {
  type: 'meeting_open' | 'agent_join' | 'agent_speak' | 'agent_pass' | 'meeting_conclude';
  meetingId: string;
  agent: string;
  content?: string;
}

export interface MeetingOrchestratorOptions {
  maxRounds?: number;
  maxTokens?: number;
  /** Minimum cross-agent interactions before conclude is allowed (default 3) */
  minInteractions?: number;
}

/** Atomic group: all callees must respond before anything else happens. */
interface ReplyGroup {
  caller: string;
  message: string;
  callees: string[];
  responded: Set<string>;
}

// ─── Orchestrator ───────────────────────────────────────────────────────

export class MeetingOrchestrator {
  private readonly room: ConversationRoom;
  private readonly mgr: MeetingManager;
  private readonly maxRounds: number;
  private readonly maxTokens: number;
  private readonly minInteractions: number;
  private eventHandler?: (chunk: OutboundChunk) => void;

  constructor(room: ConversationRoom, mgr: MeetingManager, options: MeetingOrchestratorOptions = {}) {
    this.room = room;
    this.mgr = mgr;
    this.maxRounds = options.maxRounds ?? 100;
    this.maxTokens = options.maxTokens ?? 2048;
    this.minInteractions = options.minInteractions ?? 3;
  }

  onEvent(handler: (chunk: OutboundChunk) => void): void { this.eventHandler = handler; }
  private emit(chunk: OutboundChunk): void { this.eventHandler?.(chunk); }

  // ─── Simple meeting (TurnManager-driven, kept for backward compat) ────

  async runMeeting(masterName: string, topic: string, participantNames: string[]): Promise<string> {
    const meeting = this.mgr.open(masterName, topic, participantNames);
    if (!meeting) { this.emit({ type: 'text', text: '다른 회의가 진행 중입니다.', agent: 'system' }); return ''; }

    this.emit({ type: 'tool_call', name: 'open_meeting', input: { topic, participants: participantNames }, agent: masterName });
    for (const name of participantNames) {
      this.mgr.join(meeting.id, name);
      this.emit({ type: 'tool_call', name: 'join_meeting', input: { meetingId: meeting.id }, agent: name });
    }

    const opening = await this.say(masterName, `회의 주제: "${topic}". 참가자: ${meeting.participants.join(', ')}. 짧게 시작하세요.`);
    this.mgr.speak(meeting.id, masterName, opening);
    this.room.addAgentMessage(masterName, opening);
    this.emit({ type: 'text', text: opening, agent: masterName });

    const tm = new TurnManager({ maxResponders: 2, minConfidence: 0.3, followUpMinConfidence: 0.4 });
    let silentRounds = 0;

    for (let round = 0; round < this.maxRounds; round++) {
      const lastMsg = this.room.history()[this.room.history().length - 1];
      if (!lastMsg) break;
      const result = await tm.handleMessage(this.room, lastMsg);
      if (result.responses.length === 0) {
        silentRounds++;
        if (silentRounds >= 2) return this.conclude(meeting, masterName);
        continue;
      }
      silentRounds = 0;
      for (const r of result.responses) {
        this.mgr.speak(meeting.id, r.agentName, r.content);
        this.emit({ type: 'text', text: r.content, agent: r.agentName });
      }
      if (round > 0 && round % 3 === 0) {
        const shouldEnd = await this.moderatorSay(masterName,
          `${this.mgr.formatHistory(meeting.id)}\n\n---\n합의 도달했으면 "CONCLUDE: [한 줄 결론]". 아니면 "CONTINUE".`);
        if (shouldEnd.includes('CONCLUDE')) {
          return this.concludeWith(meeting, masterName, shouldEnd.replace(/^CONCLUDE:?\s*/i, ''));
        }
      }
    }
    return this.conclude(meeting, masterName);
  }

  // ─── 1:1 Thread ───────────────────────────────────────────────────────

  async runThread(openerName: string, otherName: string, topic: string): Promise<string> {
    const meeting = this.mgr.open(openerName, topic, [otherName]);
    if (!meeting) { this.emit({ type: 'text', text: '다른 회의가 진행 중입니다.', agent: 'system' }); return ''; }
    this.emit({ type: 'tool_call', name: 'open_thread', input: { agent: otherName, topic }, agent: openerName });
    this.mgr.join(meeting.id, otherName);
    this.emit({ type: 'tool_call', name: 'join_meeting', input: { meetingId: meeting.id }, agent: otherName });
    const speakers = [openerName, otherName];
    let staleCount = 0;
    for (let turn = 0; turn < 20; turn++) {
      const speaker = speakers[turn % 2];
      const history = this.mgr.formatHistory(meeting.id);
      const text = await this.say(speaker,
        `${history}\n\n---\n대화를 이어가세요. 합의 시 "AGREED: [합의내용]".`);
      if (!text || text.includes('mock agent')) break;
      this.mgr.speak(meeting.id, speaker, text);
      this.emit({ type: 'text', text, agent: speaker });
      if (text.includes('AGREED')) {
        const summary = text.replace(/^AGREED:?\s*/i, '');
        this.mgr.conclude(meeting.id, openerName, summary);
        this.emit({ type: 'tool_call', name: 'conclude_meeting', input: { meetingId: meeting.id }, agent: openerName });
        return summary;
      }
      if (text.includes('정보') && text.includes('필요')) staleCount++; else staleCount = 0;
      if (staleCount >= 3) {
        const summary = '추가 정보 필요. 정보 확보 후 재논의.';
        this.mgr.conclude(meeting.id, openerName, summary);
        this.emit({ type: 'text', text: summary, agent: openerName });
        return summary;
      }
    }
    return '';
  }

  // ─── Conclude helpers ─────────────────────────────────────────────────

  private async conclude(meeting: Meeting, masterName: string): Promise<string> {
    const summary = await this.say(masterName,
      `${this.mgr.formatHistory(meeting.id)}\n\n---\n회의 결론을 한 줄로 정리하세요.`);
    return this.concludeWith(meeting, masterName, summary);
  }

  private concludeWith(meeting: Meeting, masterName: string, summary: string): string {
    this.mgr.speak(meeting.id, masterName, summary);
    this.mgr.conclude(meeting.id, masterName, summary);
    this.emit({ type: 'tool_call', name: 'conclude_meeting', input: { meetingId: meeting.id }, agent: masterName });
    this.emit({ type: 'text', text: summary, agent: masterName });
    return summary;
  }

  // =====================================================================
  // runMeetingStream — ReplyGroup-based main loop
  // =====================================================================

  async runMeetingStream(meeting: Meeting, onChunk: (chunk: OutboundChunk) => void): Promise<string> {
    this.eventHandler = onChunk;

    // Join participants
    for (const inv of [...meeting.invited]) {
      if (!this.room.getParticipant(inv)) continue;
      this.mgr.join(meeting.id, inv);
      this.emit({ type: 'tool_call', name: 'join_meeting', input: { meetingId: meeting.id }, agent: inv });
    }

    // Master opens
    const topicPrompt = `[회의 주제: ${meeting.topic}] 각자 의견을 말해주세요.`;
    this.room.addAgentMessage(meeting.master, topicPrompt);
    this.mgr.speak(meeting.id, meeting.master, topicPrompt);
    this.emit({ type: 'text', text: topicPrompt, agent: meeting.master });

    // ── State ──
    const allP = [...meeting.participants as string[]];
    const log = (msg: string) => console.log(`[Meeting:${meeting.id}] ${msg}`);
    let totalSpeaks = 0;
    let silentTurns = 0;
    let interactionCount = 0;
    let completedRounds = 0;
    const lastSpokeTurn: Record<string, number> = {};
    for (const p of allP) lastSpokeTurn[p] = -1;

    // ReplyGroup state (multi-target tags)
    let activeGroup: ReplyGroup | null = null;
    const overflowQueue: ReplyGroup[] = [];
    let attentionRoundRobin: string[] = [];
    // Single-target tag (lightweight, doesn't block moderator)
    const pending: { next: { agent: string; caller: string; message: string } | null } = { next: null };

    log(`Started. master=${meeting.master}, participants=[${allP}]`);

    // ── Helpers ──
    const isResearch = /무엇|어떤|왜|인가|있는가|현상|원리|메커니즘/.test(meeting.topic);
    const goalDesc = isResearch
      ? `연구 토론입니다. "${meeting.topic}"에 대한 분석, 원인, 메커니즘, 가능한 접근법을 논의하세요. 실행 계획이나 일정을 세우지 마세요.`
      : `"${meeting.topic}"에 대한 구체적 답을 도출하세요.`;

    const buildPrompt = (agentName: string): string => {
      const freshH = this.mgr.formatHistory(meeting.id);
      const others = allP.filter(n => n !== agentName);
      const othersStr = others.map(n => `"${n}"`).join(', ');

      // Reply context
      let replyCtx = '';
      if (activeGroup && activeGroup.callees.includes(agentName)) {
        replyCtx = `\n[⚡ ${activeGroup.caller}이(가) 당신을 호출했습니다. 반드시 그 내용에 먼저 답하세요.]\n`;
      } else if (pending.next && pending.next.agent === agentName) {
        replyCtx = `\n[⚡ ${pending.next.caller}이(가) 당신을 호출했습니다. 반드시 그 내용에 먼저 답하세요.]\n`;
      }

      const identity = `[당신은 "${agentName}"입니다. 참가자: ${othersStr}.]${replyCtx}\n`;
      const topicAnchor = `[회의 목표: ${goalDesc}]\n\n`;
      const rules = `\n규칙:\n- 지금 가용한 정보로 진행하세요. 미루기 금지.\n- to에 직접 지정하세요. 중개 금지.\n- to 필드의 대상과 메시지 본문의 질문 대상이 일치해야 합니다.`;

      return totalSpeaks === 0
        ? `${identity}${topicAnchor}${freshH}\n\nspeak 도구로 ${agentName}의 관점에서 의견을 제시하세요.\nto에 다음 발언자를 지정하세요 (${othersStr}).${rules}`
        : `${identity}${topicAnchor}${freshH}\n\nspeak 도구로 주제의 답에 가까워지도록 발언하세요.\n- 이전 발언을 발전시키거나 보충하세요.\n- to에 다음 발언자를 지정하세요 (${othersStr}).${rules}`;
    };

    const emitSpeak = async (agentName: string, result: { content: string; to?: string[] }) => {
      if (totalSpeaks > 0) await sleep(800);
      // Include replyTo (who called this speaker) for UI context
      const replyTo = activeGroup?.callees.includes(agentName) ? activeGroup.caller
        : pending.next?.agent === agentName ? pending.next.caller
        : undefined;
      this.emit({ type: 'tool_call', name: 'speak', input: { to: result.to, message: result.content, replyTo }, agent: agentName });
      this.room.addAgentMessage(agentName, result.content);
      this.emit({ type: 'text', text: result.content, agent: agentName });
      totalSpeaks++;
      lastSpokeTurn[agentName] = turn;

      // Track cross-references
      const mentioned = allP.filter(n => n !== agentName && result.content.includes(n));
      if (mentioned.length > 0) interactionCount++;

      // Update completed rounds
      const minSpeak = Math.min(...allP.map(n => meeting.messages.filter(m => m.agent === n).length));
      completedRounds = Math.max(completedRounds, minSpeak);
    };

    const handleTags = (agentName: string, to: string[], content: string) => {
      const toList = to ?? [];
      let callees: string[];
      if (toList.includes('everyone')) {
        callees = allP.filter(n => n !== agentName);
      } else {
        callees = toList.filter(t => allP.includes(t) && t !== agentName);
      }

      if (callees.length > 1) {
        // Multi-target: create ReplyGroup (atomic drain guarantee)
        const newGroup: ReplyGroup = { caller: agentName, message: content, callees, responded: new Set() };
        if (activeGroup && activeGroup.responded.size < activeGroup.callees.length) {
          overflowQueue.push(newGroup);
          log(`  → overflow queue (active group not drained): [${callees}]`);
        } else {
          activeGroup = newGroup;
          log(`  → new ReplyGroup: [${callees}] (caller: ${agentName})`);
        }
      } else if (callees.length === 1) {
        // Single target: lightweight — just set pendingNext (no ReplyGroup)
        pending.next = { agent: callees[0], caller: agentName, message: content };
        log(`  → pendingNext: ${callees[0]} (caller: ${agentName})`);
      }
    };

    // ── Main loop ──
    let turn = 0;
    for (; turn < this.maxRounds * 3; turn++) {

      // ═══ Phase A: Master moderation ═══
      // ONLY when no pending reply obligations
      if (totalSpeaks > 0
        && turn >= allP.length
        && turn % 3 === 0
        && activeGroup === null
        && overflowQueue.length === 0
        && attentionRoundRobin.length === 0) {

        log(`turn ${turn}: moderator check...`);
        const preH = this.mgr.formatHistory(meeting.id);
        const modResult = await this.moderatorCheck(meeting, preH, interactionCount, completedRounds);
        log(`turn ${turn}: moderator → ${modResult.action}`);

        if (modResult.action === 'conclude') {
          // Propose conclusion + objection check
          const concluded = await this.proposeAndConfirm(meeting, allP, turn, lastSpokeTurn);
          if (concluded) return concluded;
          log(`turn ${turn}: objection raised — continuing`);
        } else if (modResult.action === 'stimulate') {
          // Master forces cross-discussion
          const stimResult = await this.singleShotAction(meeting.master, modResult.prompt!, meeting.id);
          if (stimResult.action === 'speak' && stimResult.content) {
            await emitSpeak(meeting.master, { content: stimResult.content!, to: stimResult.to });
            handleTags(meeting.master, stimResult.to ?? [], stimResult.content);
          }
        }
        // 'continue' → no action
      }

      // ═══ Phase B: Select next speaker ═══
      let speaker: string | null = null;
      let reason = '';

      // Check if initial round-robin is still needed (not everyone has spoken once)
      const initialRRDone = allP.every(n => lastSpokeTurn[n] >= 0);
      const nextRRAgent = !initialRRDone ? allP.find(n => lastSpokeTurn[n] < 0) : null;

      if (nextRRAgent) {
        // Initial round-robin takes priority over everything
        // (defer ReplyGroups until everyone has spoken once)
        speaker = nextRRAgent;
        reason = `initial-rr → ${speaker} (ensuring voice equity)`;
      } else if (activeGroup) {
        // Drain active ReplyGroup
        const next = activeGroup.callees.find(c => !activeGroup!.responded.has(c));
        if (next) {
          speaker = next;
          reason = `reply-group (${activeGroup.responded.size + 1}/${activeGroup.callees.length}, caller: ${activeGroup.caller})`;
        } else {
          activeGroup = null;
          if (overflowQueue.length > 0) {
            activeGroup = overflowQueue.shift()!;
            speaker = activeGroup.callees[0];
            reason = `overflow-group → ${speaker}`;
          }
        }
      }

      if (!speaker && attentionRoundRobin.length > 0) {
        speaker = attentionRoundRobin.shift()!;
        reason = `attention-rr → ${speaker}`;
      }

      if (!speaker && !activeGroup && overflowQueue.length > 0) {
        activeGroup = overflowQueue.shift()!;
        speaker = activeGroup.callees[0];
        reason = `overflow → ${speaker}`;
      }

      if (!speaker && pending.next) {
        speaker = pending.next.agent;
        reason = `pending-next → ${speaker} (caller: ${pending.next.caller})`;
        // Don't clear pending.next here — buildPrompt/emitSpeak need it for reply context.
        // It gets cleared after the speaker executes (below).
      }

      if (!speaker) {
        // Evaluate fallback
        const mH = this.mgr.formatHistory(meeting.id);
        const willing = await this.evaluateWhoSpeaks(allP, mH, false);
        if (willing.length > 0) {
          speaker = willing[0];
          reason = `evaluate → ${speaker}`;
          silentTurns = 0;
        } else {
          silentTurns++;
          log(`turn ${turn}: evaluate → nobody (silent=${silentTurns})`);
          if (silentTurns >= 2) {
            if (completedRounds < 2) {
              // Force stimulation
              log(`turn ${turn}: forcing cross-discussion (rounds=${completedRounds})`);
              const leastActive = allP.filter(n => n !== meeting.master)
                .sort((a, b) => (lastSpokeTurn[a] ?? -1) - (lastSpokeTurn[b] ?? -1)).slice(0, 2);
              const stimPrompt = `${mH}\n\n---\n토론이 일방적 발표에 그쳤습니다. speak 도구로 ${leastActive.join(', ')}에게 구체적 질문을 던지세요. to에 해당 참가자를 지정하세요.`;
              const stimResult = await this.singleShotAction(meeting.master, stimPrompt, meeting.id);
              if (stimResult.action === 'speak' && stimResult.content) {
                await emitSpeak(meeting.master, { content: stimResult.content!, to: stimResult.to });
                handleTags(meeting.master, stimResult.to ?? [], stimResult.content);
              }
              silentTurns = 0;
            } else {
              // Allow conclude
              const concluded = await this.proposeAndConfirm(meeting, allP, turn, lastSpokeTurn);
              if (concluded) return concluded;
              silentTurns = 0;
            }
          }
          continue;
        }
      }

      if (!speaker) continue;
      log(`turn ${turn}: ${reason}`);

      // ═══ Phase C: Speaker executes ═══
      const prompt = buildPrompt(speaker);
      log(`turn ${turn}: calling singleShotAction(${speaker})`);
      const result = await this.singleShotAction(speaker, prompt, meeting.id);
      log(`turn ${turn}: ${speaker} → ${result.action}, to=${JSON.stringify(result.to)?.slice(0, 40)}`);

      if (result.action === 'attention' && result.content) {
        // Attention: clear everything, force round-robin
        if (totalSpeaks > 0) await sleep(800);
        activeGroup = null;
        overflowQueue.length = 0;
        this.emit({ type: 'tool_call', name: 'attention', input: { message: result.content }, agent: speaker });
        this.room.addAgentMessage(speaker, `⚠️ [주목] ${result.content}`);
        this.emit({ type: 'text', text: `⚠️ [주목] ${result.content}`, agent: speaker });
        totalSpeaks++;
        lastSpokeTurn[speaker] = turn;
        attentionRoundRobin = allP.filter(n => n !== speaker);
        log(`turn ${turn}: ⚠️ ATTENTION → rr: [${attentionRoundRobin}]`);

      } else if (result.action === 'speak' && result.content) {
        await emitSpeak(speaker, { content: result.content!, to: result.to });
        handleTags(speaker, result.to ?? [], result.content);

      } else if (result.action === 'pass') {
        log(`turn ${turn}: ${speaker} passed`);
      }

      // Clear pending.next after speaker has executed (reply context was already consumed)
      if (pending.next && pending.next.agent === speaker) {
        pending.next = null;
      }

      // Mark responded in active group
      if (activeGroup && activeGroup.callees.includes(speaker)) {
        activeGroup.responded.add(speaker);
        if (activeGroup.responded.size >= activeGroup.callees.length) {
          log(`turn ${turn}: ReplyGroup drained (all ${activeGroup.callees.length} responded)`);
          activeGroup = null;
          // Promote overflow
          if (overflowQueue.length > 0) {
            activeGroup = overflowQueue.shift()!;
            log(`turn ${turn}: promoted overflow group: [${activeGroup.callees}]`);
          }
        }
      }
    }

    log('maxRounds reached, concluding');
    return this.conclude(meeting, meeting.master);
  }

  // =====================================================================
  // Moderator (separate persona from participant)
  // =====================================================================

  private static readonly MODERATOR_PROMPT = `당신은 중립적 토론 사회자입니다. 참가자의 입장이 아닌 제3자 관점에서 판단합니다.
- 모든 참가자가 충분히 발언했는지 확인하세요.
- 서로 간 반박과 보충이 있었는지 확인하세요.
- 일방적 발표만 있고 교차 토론이 없으면 아직 부족합니다.
- 합의가 아닌 "모두 길게 말했다"는 이유로 종료하지 마세요.`;

  private async moderatorSay(agentName: string, prompt: string): Promise<string> {
    const p = this.room.getParticipant(agentName);
    if (!p) return '';
    const resp = await p.llm.complete(
      [{ role: 'user', content: prompt }] as LLMMessage[],
      { systemPrompt: MeetingOrchestrator.MODERATOR_PROMPT, maxTokens: this.maxTokens },
    );
    return resp.content.trim();
  }

  /**
   * Moderator checks: continue / stimulate / conclude.
   * Uses separate moderator persona. Returns action + optional prompt for stimulation.
   */
  private async moderatorCheck(
    meeting: Meeting,
    mHistory: string,
    interactionCount: number,
    completedRounds: number,
  ): Promise<{ action: 'continue' | 'stimulate' | 'conclude'; prompt?: string }> {
    const msgCount = meeting.messages.length;

    const check = await this.moderatorSay(meeting.master,
      `${mHistory}\n\n---\n[교차 토론 ${interactionCount}회, 발언 라운드 ${completedRounds}회, 총 발언 ${msgCount}개]\n\n판단하세요. 한 단어로만:\n- 개입 불필요: "CONTINUE"\n- 일방적 발표만 있고 교차 토론 부족: "STIMULATE"\n- 충분히 논의되고 교차 토론도 있었음: "CONCLUDE"`);

    if (check.includes('CONCLUDE')) {
      if (interactionCount < this.minInteractions || completedRounds < 2) {
        console.log(`[Moderator] conclude blocked: interactions=${interactionCount}/${this.minInteractions}, rounds=${completedRounds}/2`);
        // Force stimulate instead
        const allNames = [...meeting.participants as string[]].filter(n => n !== meeting.master);
        const prompt = `${mHistory}\n\n---\n교차 토론이 부족합니다 (${interactionCount}회). speak 도구로 아직 서로 반응하지 않은 참가자에게 질문을 던지세요.`;
        return { action: 'stimulate', prompt };
      }
      return { action: 'conclude' };
    }

    if (check.includes('STIMULATE')) {
      const allNames = [...meeting.participants as string[]].filter(n => n !== meeting.master);
      const prompt = `${mHistory}\n\n---\n일방적 발표에 그쳤습니다. speak 도구로 참가자들 사이에 교차 토론을 유도하세요. 구체적 질문을 던지고 to에 대상을 지정하세요.`;
      return { action: 'stimulate', prompt };
    }

    return { action: 'continue' };
  }

  /**
   * Propose conclusion + check objections from all participants.
   * Returns summary string if concluded, null if objection raised.
   */
  private async proposeAndConfirm(
    meeting: Meeting,
    allP: string[],
    turn: number,
    lastSpokeTurn: Record<string, number>,
  ): Promise<string | null> {
    const mHistory = this.mgr.formatHistory(meeting.id);

    // Step 1: Master proposes summary
    const summaryPrompt = `${mHistory}\n\n---\n사회자로서 지금까지 논의를 간결하게 정리하세요. speak 도구로 to:"everyone"에게:\n- 합의된 점\n- 남은 이견\n- 제안하는 결론\n마지막에 "이의 있으면 말씀하세요"를 붙이세요.\n금지: "다음에", "2차 회의". 지금 결론내세요.`;
    const summary = await this.singleShotAction(meeting.master, summaryPrompt, meeting.id);
    if (summary.action === 'speak' && summary.content) {
      this.emit({ type: 'tool_call', name: 'speak', input: { to: ['everyone'], message: summary.content }, agent: meeting.master });
      this.room.addAgentMessage(meeting.master, summary.content);
      this.emit({ type: 'text', text: summary.content, agent: meeting.master });
    }

    // Step 2: Each participant — object or pass
    const others = allP.filter(n => n !== meeting.master);
    const objections: { name: string; content: string }[] = [];
    for (const name of others) {
      const freshH = this.mgr.formatHistory(meeting.id);
      const objResult = await this.singleShotAction(name,
        `[당신은 "${name}"입니다.]\n\n${freshH}\n\n---\n사회자가 결론을 제시했습니다. 이의가 있으면 speak으로 반박하세요. 동의하면 pass_turn하세요.`, meeting.id);
      if (objResult.action === 'speak' && objResult.content) {
        await sleep(800);
        this.emit({ type: 'tool_call', name: 'speak', input: { to: objResult.to, message: objResult.content }, agent: name });
        this.room.addAgentMessage(name, objResult.content);
        this.emit({ type: 'text', text: objResult.content, agent: name });
        lastSpokeTurn[name] = turn;
        objections.push({ name, content: objResult.content });
      }
    }

    if (objections.length === 0) {
      // Unanimous — close
      const finalSummary = summary.content ?? await this.say(meeting.master, `${this.mgr.formatHistory(meeting.id)}\n\n회의 결론을 한 줄로.`);
      this.mgr.speak(meeting.id, meeting.master, finalSummary);
      this.mgr.conclude(meeting.id, meeting.master, finalSummary);
      this.emit({ type: 'tool_call', name: 'conclude_meeting', input: { meetingId: meeting.id }, agent: meeting.master });
      return finalSummary;
    }

    // Majority vote + master judgment
    const agreeCount = others.length - objections.length;
    const majorityAgree = agreeCount > objections.length;
    const voteLabel = `[투표: 동의 ${agreeCount} / 이의 ${objections.length} → ${majorityAgree ? '과반 동의' : '과반 반대'}]`;
    this.emit({ type: 'text', text: voteLabel, agent: meeting.master });

    const objSummary = objections.map(o => `${o.name}: ${o.content.slice(0, 100)}`).join('\n');
    const masterDecision = await this.moderatorSay(meeting.master,
      `${this.mgr.formatHistory(meeting.id)}\n\n---\n${voteLabel}\n이의 내용:\n${objSummary}\n\n${majorityAgree
        ? '과반이 동의합니다. 이의는 기록하고 종료하는 것을 권고합니다. "CLOSE" 또는 이의가 중대하면 "REOPEN".'
        : '과반이 반대합니다. 토론 재개를 권고합니다. "REOPEN" 또는 이의가 사소하면 "CLOSE".'}\n한 단어로.`);

    if (masterDecision.includes('CLOSE')) {
      const finalSummary = (summary.content ?? '') + `\n\n[남은 이견] ${objections.map(o => `${o.name}: ${o.content.slice(0, 80)}`).join('; ')}`;
      this.mgr.speak(meeting.id, meeting.master, finalSummary);
      this.mgr.conclude(meeting.id, meeting.master, finalSummary);
      this.emit({ type: 'tool_call', name: 'conclude_meeting', input: { meetingId: meeting.id }, agent: meeting.master });
      this.emit({ type: 'text', text: `[남은 이견 포함하여 종료] ${objections.map(o => o.name).join(', ')}의 이의가 기록되었습니다.`, agent: meeting.master });
      return finalSummary;
    }

    // REOPEN — continue discussion
    return null;
  }

  // =====================================================================
  // singleShotAction — agent tool loop
  // =====================================================================

  private async singleShotAction(
    agentName: string,
    prompt: string,
    meetingId: string,
  ): Promise<{ action: 'speak' | 'pass' | 'attention' | 'none'; content?: string; to?: string[] }> {
    const p = this.room.getParticipant(agentName);
    if (!p) return { action: 'none' };

    const meeting = this.mgr.get(meetingId);
    const participantNames = meeting
      ? [...new Set([...meeting.participants as string[], meeting.master])].filter(n => n !== agentName)
      : [];
    const toEnum = ['everyone', ...participantNames];

    // Meeting tools
    const meetingTools = [
      {
        name: 'speak',
        description: 'Post a message in the meeting. "to" can be a single name or array for multiple targets.',
        parameters: {
          type: 'object' as const,
          properties: {
            to: {
              description: `Who to address: ${toEnum.map(n => `"${n}"`).join(', ')}`,
              oneOf: [
                { type: 'string' as const, enum: toEnum },
                { type: 'array' as const, items: { type: 'string' as const, enum: toEnum } },
              ],
            },
            message: { type: 'string' as const, description: 'Your message' },
          },
          required: ['to', 'message'],
        },
      },
      {
        name: 'attention',
        description: 'Interrupt the meeting. Clears speaker queue. Use when off-track or critical point missed.',
        parameters: {
          type: 'object' as const,
          properties: { message: { type: 'string' as const, description: 'Urgent message' } },
          required: ['message'],
        },
      },
      {
        name: 'pass_turn',
        description: 'Skip your turn.',
        parameters: { type: 'object' as const, properties: {} },
      },
    ];

    // Agent's own tools (web_search, etc.)
    const agentTools: typeof meetingTools = [];
    const agentToolExecutor = p.runtime ? (p.runtime as unknown as { tools?: { list(): Array<{ name: string; description: string; parameters: Record<string, unknown> }>; execute(name: string, callId: string, input: unknown): Promise<unknown> } }).tools : undefined;
    if (agentToolExecutor) {
      for (const t of agentToolExecutor.list()) {
        if (['open_meeting', 'open_thread', 'join_meeting', 'speak', 'pass_turn', 'raise_hand', 'conclude_meeting', 'get_meeting'].includes(t.name)) continue;
        agentTools.push({ name: t.name, description: t.description, parameters: t.parameters as { type: 'object'; properties: Record<string, unknown> } });
      }
    }

    const allTools = [...meetingTools, ...agentTools];
    let messages: LLMMessage[] = [{ role: 'user', content: prompt }];

    for (;;) {
      const resp = await p.llm.complete(
        messages,
        { systemPrompt: p.respondPrompt ?? p.card.description, maxTokens: this.maxTokens, tools: allTools },
      );

      if (resp.toolCalls && resp.toolCalls.length > 0) {
        const tc = resp.toolCalls[0];

        if (tc.name === 'speak') {
          const args = tc.arguments as { to: string | string[]; message: string };
          const message = args.message?.trim() || resp.content?.trim() || '';
          const rawTo = Array.isArray(args.to) ? args.to : [args.to || 'everyone'];
          let to = rawTo.filter(t => t !== agentName).map(t => t || 'everyone');
          if (to.length === 0) to.push('everyone');
          // Fix to-content mismatch
          if (!to.includes('everyone') && message) {
            const mentioned = participantNames.filter(n => message.includes(n) && !to.includes(n));
            const participant = this.room.getParticipant(agentName);
            // Also check aliases
            for (const pName of participantNames) {
              if (to.includes(pName) || mentioned.includes(pName)) continue;
              const pp = this.room.getParticipant(pName);
              if (pp?.aliases?.some(a => message.includes(a))) mentioned.push(pName);
            }
            if (mentioned.length > 0) to = [...new Set([...mentioned, ...to])];
          }
          if (message) {
            this.mgr.speak(meetingId, agentName, message);
            return { action: 'speak', content: message, to };
          }
        }
        if (tc.name === 'attention') {
          const args = tc.arguments as { message: string };
          const message = args.message?.trim() || resp.content?.trim() || '';
          if (message) {
            this.mgr.speak(meetingId, agentName, `⚠️ [주목] ${message}`);
            return { action: 'attention', content: message };
          }
        }
        if (tc.name === 'pass_turn') {
          return { action: 'pass' };
        }

        // Agent tool → execute and re-prompt
        if (agentToolExecutor) {
          try {
            const result = await agentToolExecutor.execute(tc.name, `meeting-${Date.now()}`, tc.arguments);
            const resultText = typeof result === 'string' ? result
              : (result as { content?: string })?.content ?? JSON.stringify(result);
            this.emit({ type: 'tool_call', name: tc.name, input: tc.arguments, agent: agentName });
            messages = [
              ...messages,
              { role: 'assistant', content: `[Tool: ${tc.name}] ${String(resultText).slice(0, 500)}` } as LLMMessage,
              { role: 'user', content: '위 도구 결과를 바탕으로 speak 도구로 발언하세요.' } as LLMMessage,
            ];
            continue;
          } catch (err) {
            console.log(`[SingleShot:${agentName}] ${tc.name} error: ${err}`);
          }
        }
      }

      // Fallback: text as speech
      if (resp.content?.trim()) {
        const text = resp.content.trim();
        if (text === 'PASS' || text.includes('pass_turn')) return { action: 'pass' };
        this.mgr.speak(meetingId, agentName, text);
        return { action: 'speak', content: text, to: ['everyone'] };
      }

      break;
    }

    return { action: 'none' };
  }

  // =====================================================================
  // evaluateWhoSpeaks
  // =====================================================================

  private async evaluateWhoSpeaks(
    participants: string[],
    meetingHistory: string,
    isFirstRound: boolean,
  ): Promise<string[]> {
    if (isFirstRound) return [...participants];

    const evaluations = await Promise.all(
      participants.map(async (name) => {
        const p = this.room.getParticipant(name);
        if (!p) return { name, want: false, confidence: 0 };
        try {
          const resp = await p.llm.complete(
            [{ role: 'user' as const, content: `${meetingHistory}\n\n---\n위 토론을 읽고, 당신이 새롭게 추가할 관점이나 반박이 있는지 판단하세요.\nJSON으로만 답하세요: {"speak": true/false, "confidence": 0.0-1.0, "reason": "한 문장"}` }],
            { systemPrompt: p.respondPrompt ?? p.card.description, maxTokens: 80 },
          );
          const cleaned = resp.content.trim().replace(/^```(?:json)?\n?|\n?```$/g, '');
          const parsed = JSON.parse(cleaned) as { speak?: boolean; confidence?: number };
          return { name, want: parsed.speak === true, confidence: parsed.confidence ?? 0 };
        } catch {
          return { name, want: false, confidence: 0 };
        }
      }),
    );

    return evaluations
      .filter(e => e.want && e.confidence >= 0.3)
      .sort((a, b) => b.confidence - a.confidence)
      .map(e => e.name);
  }

  // =====================================================================
  // say (participant persona)
  // =====================================================================

  private async say(agentName: string, prompt: string): Promise<string> {
    const p = this.room.getParticipant(agentName);
    if (!p) return '';
    const resp = await p.llm.complete(
      [{ role: 'user', content: prompt }] as LLMMessage[],
      { systemPrompt: p.respondPrompt ?? p.card.description, maxTokens: this.maxTokens },
    );
    return resp.content.trim();
  }
}
