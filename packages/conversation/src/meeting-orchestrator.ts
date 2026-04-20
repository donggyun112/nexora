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
import { type MeetingPromptTemplates, DEFAULT_MEETING_PROMPTS, interpolate } from './meeting-prompts.js';

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
  /** Custom prompt templates. Partial overrides are merged with defaults. */
  prompts?: Partial<MeetingPromptTemplates>;
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
  private readonly prompts: MeetingPromptTemplates;
  private eventHandler?: (chunk: OutboundChunk) => void;

  constructor(room: ConversationRoom, mgr: MeetingManager, options: MeetingOrchestratorOptions = {}) {
    this.room = room;
    this.mgr = mgr;
    this.maxRounds = options.maxRounds ?? 100;
    this.maxTokens = options.maxTokens ?? 2048;
    this.minInteractions = options.minInteractions ?? 3;
    this.prompts = { ...DEFAULT_MEETING_PROMPTS, ...options.prompts };
  }

  onEvent(handler: (chunk: OutboundChunk) => void): void { this.eventHandler = handler; }
  private emit(chunk: OutboundChunk): void { this.eventHandler?.(chunk); }

  // ─── Simple meeting (TurnManager-driven, kept for backward compat) ────

  async runMeeting(masterName: string, topic: string, participantNames: string[]): Promise<string> {
    const meeting = this.mgr.open(masterName, topic, participantNames);
    if (!meeting) { this.emit({ type: 'text', text: this.prompts.meetingBusy, agent: 'system' }); return ''; }

    this.emit({ type: 'tool_call', name: 'open_meeting', input: { topic, participants: participantNames }, agent: masterName });
    for (const name of participantNames) {
      this.mgr.join(meeting.id, name);
      this.emit({ type: 'tool_call', name: 'join_meeting', input: { meetingId: meeting.id }, agent: name });
    }

    const opening = await this.say(masterName, interpolate(this.prompts.openingSimple, { topic, participants: meeting.participants.join(', ') }));
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
          interpolate(this.prompts.simpleConcludeCheck, { history: this.mgr.formatHistory(meeting.id) }));
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
    if (!meeting) { this.emit({ type: 'text', text: this.prompts.meetingBusy, agent: 'system' }); return ''; }
    this.emit({ type: 'tool_call', name: 'open_thread', input: { agent: otherName, topic }, agent: openerName });
    this.mgr.join(meeting.id, otherName);
    this.emit({ type: 'tool_call', name: 'join_meeting', input: { meetingId: meeting.id }, agent: otherName });
    const speakers = [openerName, otherName];
    let staleCount = 0;
    for (let turn = 0; turn < 20; turn++) {
      const speaker = speakers[turn % 2];
      const history = this.mgr.formatHistory(meeting.id);
      const text = await this.say(speaker,
        interpolate(this.prompts.threadContinue, { history }));
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
        const summary = this.prompts.threadStaleConclusion;
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
      interpolate(this.prompts.concludeSummary, { history: this.mgr.formatHistory(meeting.id) }));
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
    const topicPrompt = interpolate(this.prompts.openingStream, { topic: meeting.topic });
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
    const topicPattern = typeof this.prompts.researchTopicPattern === 'string'
      ? new RegExp(this.prompts.researchTopicPattern, 'i')
      : this.prompts.researchTopicPattern;
    const isResearch = topicPattern.test(meeting.topic);
    const goalDesc = isResearch
      ? interpolate(this.prompts.researchGoal, { topic: meeting.topic })
      : interpolate(this.prompts.decisionGoal, { topic: meeting.topic });

    const buildPrompt = (agentName: string): string => {
      const freshH = this.mgr.formatHistory(meeting.id);
      const others = allP.filter(n => n !== agentName);
      const othersStr = others.map(n => `"${n}"`).join(', ');

      // Reply context
      let replyCtx = '';
      const caller = activeGroup?.callees.includes(agentName) ? activeGroup.caller
        : pending.next?.agent === agentName ? pending.next.caller : null;
      if (caller) replyCtx = interpolate(this.prompts.replyContext, { caller });

      const identityStr = interpolate(this.prompts.identity, { agentName, others: othersStr }) + replyCtx;
      const anchor = interpolate(this.prompts.topicAnchor, { goalDesc });

      return totalSpeaks === 0
        ? `${identityStr}${anchor}${freshH}\n\n${interpolate(this.prompts.firstSpeak, { agentName, others: othersStr })}\n${this.prompts.rules}`
        : `${identityStr}${anchor}${freshH}\n\n${interpolate(this.prompts.continueSpeak, { others: othersStr })}\n${this.prompts.rules}`;
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
              const stimPrompt = interpolate(this.prompts.forceStimulation, { history: mH, leastActive: leastActive.join(', ') });
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

  private async moderatorSay(agentName: string, prompt: string): Promise<string> {
    const p = this.room.getParticipant(agentName);
    if (!p) return '';
    const resp = await p.llm.complete(
      [{ role: 'user', content: prompt }] as LLMMessage[],
      { systemPrompt: this.prompts.moderatorPersona, maxTokens: this.maxTokens },
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
      interpolate(this.prompts.moderatorCheck, { history: mHistory, interactionCount, completedRounds, msgCount }));

    if (check.includes('CONCLUDE')) {
      if (interactionCount < this.minInteractions || completedRounds < 2) {
        console.log(`[Moderator] conclude blocked: interactions=${interactionCount}/${this.minInteractions}, rounds=${completedRounds}/2`);
        // Force stimulate instead
        const allNames = [...meeting.participants as string[]].filter(n => n !== meeting.master);
        const prompt = interpolate(this.prompts.insufficientInteraction, { history: mHistory, interactionCount });
        return { action: 'stimulate', prompt };
      }
      return { action: 'conclude' };
    }

    if (check.includes('STIMULATE')) {
      const allNames = [...meeting.participants as string[]].filter(n => n !== meeting.master);
      const prompt = interpolate(this.prompts.generalStimulation, { history: mHistory });
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
    const summaryPrompt = interpolate(this.prompts.summaryProposal, { history: mHistory });
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
        interpolate(this.prompts.objectionCheck, { agentName: name, history: freshH }), meeting.id);
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
      const finalSummary = summary.content ?? await this.say(meeting.master, interpolate(this.prompts.concludeSummary, { history: this.mgr.formatHistory(meeting.id) }));
      this.mgr.speak(meeting.id, meeting.master, finalSummary);
      this.mgr.conclude(meeting.id, meeting.master, finalSummary);
      this.emit({ type: 'tool_call', name: 'conclude_meeting', input: { meetingId: meeting.id }, agent: meeting.master });
      return finalSummary;
    }

    // Majority vote + master judgment
    const agreeCount = others.length - objections.length;
    const majorityAgree = agreeCount > objections.length;
    const voteLabel = `[Vote: agree ${agreeCount} / object ${objections.length} → ${majorityAgree ? 'majority agree' : 'majority disagree'}]`;
    this.emit({ type: 'text', text: voteLabel, agent: meeting.master });

    const objSummary = objections.map(o => `${o.name}: ${o.content.slice(0, 100)}`).join('\n');
    const recommendation = majorityAgree
      ? 'Majority agrees. Recommend closing with objections noted. "CLOSE" or "REOPEN" if objections are critical.'
      : 'Majority disagrees. Recommend reopening discussion. "REOPEN" or "CLOSE" if objections are minor.';
    const masterDecision = await this.moderatorSay(meeting.master,
      interpolate(this.prompts.masterDecision, {
        history: this.mgr.formatHistory(meeting.id),
        voteLabel, objSummary, recommendation,
      }));

    if (masterDecision.includes('CLOSE')) {
      const finalSummary = (summary.content ?? '') + `\n\n[남은 이견] ${objections.map(o => `${o.name}: ${o.content.slice(0, 80)}`).join('; ')}`;
      this.mgr.speak(meeting.id, meeting.master, finalSummary);
      this.mgr.conclude(meeting.id, meeting.master, finalSummary);
      this.emit({ type: 'tool_call', name: 'conclude_meeting', input: { meetingId: meeting.id }, agent: meeting.master });
      this.emit({ type: 'text', text: `[Closed with dissent noted] ${objections.map(o => o.name).join(', ')}`, agent: meeting.master });
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
              { role: 'user', content: this.prompts.toolResultReprompt } as LLMMessage,
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
            [{ role: 'user' as const, content: interpolate(this.prompts.evaluateWhoSpeaks, { history: meetingHistory }) }],
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
