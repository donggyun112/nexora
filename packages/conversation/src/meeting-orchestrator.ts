/**
 * MeetingOrchestrator — framework-level meeting loop with TurnManager.
 *
 * Uses TurnManager for natural turn-taking instead of manual NEXT/OPEN/CONCLUDE.
 * Master only intervenes to open, check progress, and conclude.
 */

import type { AgentRuntime, AgentInput, LLMMessage, OutboundChunk } from '@nexora/contracts';
import { ConversationRoom } from './room.js';
import { TurnManager } from './turn-manager.js';
import type { MeetingManager, Meeting } from '@nexora/tools';

export interface MeetingEvent {
  type: 'meeting_open' | 'agent_join' | 'agent_speak' | 'agent_pass' | 'meeting_conclude';
  meetingId: string;
  agent: string;
  content?: string;
}

export interface MeetingOrchestratorOptions {
  maxRounds?: number;
  maxTokens?: number;
}

export class MeetingOrchestrator {
  private readonly room: ConversationRoom;
  private readonly mgr: MeetingManager;
  private readonly maxRounds: number;
  private readonly maxTokens: number;
  private eventHandler?: (chunk: OutboundChunk) => void;

  constructor(room: ConversationRoom, mgr: MeetingManager, options: MeetingOrchestratorOptions = {}) {
    this.room = room;
    this.mgr = mgr;
    this.maxRounds = options.maxRounds ?? 10;
    this.maxTokens = options.maxTokens ?? 400;
  }

  onEvent(handler: (chunk: OutboundChunk) => void): void { this.eventHandler = handler; }
  private emit(chunk: OutboundChunk): void { this.eventHandler?.(chunk); }

  /**
   * Run a meeting. TurnManager handles who speaks each round.
   * Master opens, checks progress every 3 rounds, concludes when done.
   */
  async runMeeting(masterName: string, topic: string, participantNames: string[]): Promise<string> {
    const meeting = this.mgr.open(masterName, topic, participantNames);
    if (!meeting) { this.emit({ type: 'text', text: '다른 회의가 진행 중입니다.', agent: 'system' }); return ''; }

    this.emit({ type: 'tool_call', name: 'open_meeting', input: { topic, participants: participantNames }, agent: masterName });
    for (const name of participantNames) {
      this.mgr.join(meeting.id, name);
      this.emit({ type: 'tool_call', name: 'join_meeting', input: { meetingId: meeting.id }, agent: name });
    }

    // Master opens
    const opening = await this.say(masterName, `회의 주제: "${topic}". 참가자: ${meeting.participants.join(', ')}. 짧게 시작하세요.`);
    this.mgr.speak(meeting.id, masterName, opening);
    this.room.addAgentMessage(masterName, opening);
    this.emit({ type: 'text', text: opening, agent: masterName });

    // TurnManager drives the conversation
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

      // Every 3 rounds, master checks if we should conclude
      if (round > 0 && round % 3 === 0) {
        const shouldEnd = await this.say(masterName,
          `${this.mgr.formatHistory(meeting.id)}\n\n---\n합의 도달했으면 "CONCLUDE: [한 줄 결론]". 아니면 "CONTINUE".`);
        if (shouldEnd.includes('CONCLUDE')) {
          const summary = shouldEnd.replace(/^CONCLUDE:?\s*/i, '');
          return this.concludeWith(meeting, masterName, summary);
        }
      }
    }

    return this.conclude(meeting, masterName);
  }

  /** Run a 1:1 thread. TurnManager alternates between two agents. */
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
        `${history}\n\n---\n대화를 이어가세요. 합의 시 "AGREED: [합의내용]". 진행 불가 시에도 "AGREED: [현재까지 정리]"로 종료.`);

      if (!text || text.includes('mock agent')) break;

      this.mgr.speak(meeting.id, speaker, text);
      this.emit({ type: 'text', text, agent: speaker });

      if (text.includes('AGREED')) {
        const summary = text.replace(/^AGREED:?\s*/i, '');
        this.mgr.conclude(meeting.id, openerName, summary);
        this.emit({ type: 'tool_call', name: 'conclude_meeting', input: { meetingId: meeting.id }, agent: openerName });
        return summary;
      }

      // Stale detection
      if (text.includes('정보') && text.includes('필요')) staleCount++;
      else staleCount = 0;
      if (staleCount >= 3) {
        const summary = '추가 정보 필요. 정보 확보 후 재논의.';
        this.mgr.conclude(meeting.id, openerName, summary);
        this.emit({ type: 'text', text: summary, agent: openerName });
        return summary;
      }
    }
    return '';
  }

  /** Auto-conclude: ask master for summary */
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
