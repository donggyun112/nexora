/**
 * MeetingOrchestrator — framework-level meeting loop.
 *
 * When an agent calls open_meeting, the orchestrator takes over:
 * 1. Master opens meeting, participants join
 * 2. Master moderates: NEXT (designate), OPEN (free floor), CONCLUDE (end)
 * 3. Designated agents run via AgentRuntime (can use tools) or LLM fallback
 * 4. Meeting events are emitted for UI streaming
 *
 * Usage:
 *   const orchestrator = new MeetingOrchestrator(room, meetingMgr);
 *   orchestrator.onEvent((event) => onChunk(event)); // SSE
 *   await orchestrator.runMeeting(masterName, topic, participantNames);
 */

import type { AgentRuntime, AgentInput, AgentEvent, LLMMessage, LLMProvider, OutboundChunk } from '@nexora/contracts';
import type { ConversationRoom, RoomParticipant } from './room.js';
import type { MeetingManager, Meeting } from '@nexora/tools';

export interface MeetingEvent {
  type: 'meeting_open' | 'agent_join' | 'agent_speak' | 'agent_pass' | 'meeting_conclude';
  meetingId: string;
  agent: string;
  content?: string;
}

export interface MeetingOrchestratorOptions {
  /** Max rounds before force-concluding. Default: 10. */
  maxRounds?: number;
  /** Max tokens for agent responses. Default: 400. */
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

  /** Register event handler for SSE streaming */
  onEvent(handler: (chunk: OutboundChunk) => void): void {
    this.eventHandler = handler;
  }

  private emit(chunk: OutboundChunk): void {
    this.eventHandler?.(chunk);
  }

  /** Run a full meeting: open → moderate → conclude */
  async runMeeting(masterName: string, topic: string, participantNames: string[]): Promise<string> {
    const meeting = this.mgr.open(masterName, topic, participantNames);
    if (!meeting) {
      this.emit({ type: 'text', text: '다른 회의가 진행 중입니다.', agent: 'system' });
      return '';
    }

    this.emit({ type: 'tool_call', name: 'open_meeting', input: { topic, participants: participantNames }, agent: masterName });

    // Participants join
    for (const name of participantNames) {
      this.mgr.join(meeting.id, name);
      this.emit({ type: 'tool_call', name: 'join_meeting', input: { meetingId: meeting.id }, agent: name });
    }

    // Master opening statement
    const opening = await this.agentSay(masterName, `회의가 열렸습니다. 주제: "${topic}". 참가자: ${meeting.participants.join(', ')}. 진행을 시작하세요.`);
    this.mgr.speak(meeting.id, masterName, opening);
    this.emit({ type: 'text', text: opening, agent: masterName });

    // Moderation loop
    let silentRounds = 0;
    let lastModerations: string[] = [];
    for (let round = 0; round < this.maxRounds; round++) {
      const history = this.mgr.formatHistory(meeting.id);
      const moderation = await this.agentSay(masterName,
        `${history}\n\n---\n회의 진행자로서 다음 중 하나만 하세요 (이전 발언을 반복하지 마세요):
1. 지명: "NEXT: [이름] [질문]"
2. 자유발언: "OPEN: [질문]"
3. 종료: "CONCLUDE: [결론]"
NEXT/OPEN/CONCLUDE 중 하나로만 시작. 부가 설명 금지.`);

      // CONCLUDE
      // Deadlock: master repeating same moderation type
      lastModerations.push(moderation.slice(0, 20));
      if (lastModerations.length >= 3) {
        const recent = lastModerations.slice(-3);
        if (recent[0] === recent[1] && recent[1] === recent[2]) {
          const summary = '논의가 교착 상태입니다. 현재까지 합의사항으로 종료합니다.';
          this.mgr.speak(meeting.id, masterName, summary);
          this.mgr.conclude(meeting.id, masterName, summary);
          this.emit({ type: 'tool_call', name: 'conclude_meeting', input: { meetingId: meeting.id }, agent: masterName });
          this.emit({ type: 'text', text: summary, agent: masterName });
          return summary;
        }
      }

      if (moderation.includes('CONCLUDE')) {
        const summary = moderation.replace(/^CONCLUDE:?\s*/i, '');
        this.mgr.speak(meeting.id, masterName, summary);
        this.mgr.conclude(meeting.id, masterName, summary);
        this.emit({ type: 'tool_call', name: 'conclude_meeting', input: { meetingId: meeting.id }, agent: masterName });
        this.emit({ type: 'text', text: summary, agent: masterName });
        return summary;
      }

      // OPEN: free floor
      const openMatch = moderation.match(/^OPEN:\s*(.*)/is);
      if (openMatch) {
        const msg = openMatch[1].trim();
        if (msg) {
          this.mgr.speak(meeting.id, masterName, msg);
          this.emit({ type: 'text', text: msg, agent: masterName });
        }
        let anySpoke = false;
        await this.freeFloor(meeting, participantNames, () => { anySpoke = true; });
        if (!anySpoke) silentRounds++;
        else silentRounds = 0;

        // Force conclude after 2 silent rounds
        if (silentRounds >= 2) {
          const summary = '참가자 응답 없음으로 회의를 종료합니다.';
          this.mgr.speak(meeting.id, masterName, summary);
          this.mgr.conclude(meeting.id, masterName, summary);
          this.emit({ type: 'tool_call', name: 'conclude_meeting', input: { meetingId: meeting.id }, agent: masterName });
          this.emit({ type: 'text', text: summary, agent: masterName });
          return summary;
        }
        continue;
      }

      // NEXT: designated speaker
      const nextMatch = moderation.match(/^(?:\**)?\s*NEXT:\s*(coder|researcher|assistant)\S*\s*(.*)/is);
      if (nextMatch) {
        const [, target, masterMsg] = nextMatch;
        if (masterMsg.trim()) {
          this.mgr.speak(meeting.id, masterName, masterMsg.trim());
          this.emit({ type: 'text', text: masterMsg.trim(), agent: masterName });
        }
        await this.agentTurn(meeting, target);
        silentRounds = 0;
        continue;
      }

      // Fallback
      this.mgr.speak(meeting.id, masterName, moderation);
      this.emit({ type: 'text', text: moderation, agent: masterName });
    }

    return '';
  }

  /** Run a 1:1 thread between two agents */
  async runThread(openerName: string, otherName: string, topic: string): Promise<string> {
    const meeting = this.mgr.open(openerName, topic, [otherName]);
    if (!meeting) {
      this.emit({ type: 'text', text: '다른 회의가 진행 중입니다.', agent: 'system' });
      return '';
    }

    this.emit({ type: 'tool_call', name: 'open_thread', input: { agent: otherName, topic }, agent: openerName });
    this.mgr.join(meeting.id, otherName);
    this.emit({ type: 'tool_call', name: 'join_meeting', input: { meetingId: meeting.id }, agent: otherName });

    const speakers = [openerName, otherName];
    let lastContents: string[] = [];
    for (let turn = 0; turn < 20; turn++) {
      const speaker = speakers[turn % 2];
      const history = this.mgr.formatHistory(meeting.id);
      const text = await this.agentSay(speaker,
        `${history}\n\n---\n대화를 이어가세요. 합의 시 "AGREED: [합의내용]". 정보 부족으로 진행 불가 시에도 "AGREED: [현재까지 합의사항]"으로 종료하세요.`);

      if (!text || text.includes('mock agent')) break;

      // Deadlock detection: if last 4 messages are similar length/pattern, force end
      lastContents.push(text.slice(0, 50));
      if (lastContents.length >= 4) {
        const recent = lastContents.slice(-4);
        const allSimilar = recent.every(c => c.includes('정보') || c.includes('필요') || c.includes('대기') || c.includes('확인'));
        if (allSimilar) {
          const summary = '정보 부족으로 회의를 종료합니다. 추가 정보 확보 후 재논의 필요.';
          this.mgr.speak(meeting.id, speaker, summary);
          this.mgr.conclude(meeting.id, openerName, summary);
          this.emit({ type: 'text', text: summary, agent: openerName });
          this.emit({ type: 'tool_call', name: 'conclude_meeting', input: { meetingId: meeting.id }, agent: openerName });
          return summary;
        }
      }

      if (!text || text.includes('mock agent')) break;

      this.mgr.speak(meeting.id, speaker, text);
      this.emit({ type: 'text', text, agent: speaker });

      if (text.includes('AGREED')) {
        const summary = text.replace(/^AGREED:?\s*/i, '');
        this.mgr.conclude(meeting.id, openerName, summary);
        this.emit({ type: 'tool_call', name: 'conclude_meeting', input: { meetingId: meeting.id }, agent: openerName });
        return summary;
      }
    }
    return '';
  }

  /** Free floor: all participants can speak if they have something to say */
  private async freeFloor(meeting: Meeting, agents: string[], onSpeak?: () => void): Promise<void> {
    for (const agent of agents) {
      const participant = this.room.getParticipant(agent);
      if (!participant) continue;

      const history = this.mgr.formatHistory(meeting.id);

      if (participant.runtime) {
        // Use AgentRunner — agent can call tools (speak, pass_turn, etc.)
        let content = '';
        const input: AgentInput = { prompt: `${history}\n\n---\n진행자가 자유 발언을 열었습니다. 당신의 전문 분야 관점에서 의견을 말하세요.` };
        for await (const event of participant.runtime.execute(input)) {
          if (event.type === 'tool_call') this.emit({ type: 'tool_call', name: event.name, input: event.input as Record<string, unknown>, agent });
          else if (event.type === 'tool_result') this.emit({ type: 'tool_result', name: event.name, isError: event.isError, agent });
          else if (event.type === 'done') content = event.content;
        }
        if (content && content !== 'PASS') {
          this.mgr.speak(meeting.id, agent, content);
          this.emit({ type: 'text', text: content, agent });
          onSpeak?.();
        }
      } else {
        // LLM fallback
        const text = await this.agentSay(agent,
          `${history}\n\n---\n진행자가 자유 발언을 열었습니다. 당신의 전문 분야 관점에서 의견을 말하세요. 할 말 없으면 "PASS".`);
        if (text && text !== 'PASS' && !text.includes('mock agent')) {
          this.mgr.speak(meeting.id, agent, text);
          this.emit({ type: 'text', text, agent });
          onSpeak?.();
        }
      }
    }
  }

  /** Single agent turn — uses AgentRuntime if available, LLM fallback */
  private async agentTurn(meeting: Meeting, agentName: string): Promise<void> {
    const participant = this.room.getParticipant(agentName);
    if (!participant) return;

    const history = this.mgr.formatHistory(meeting.id);

    // If agent has a runtime, use it (can call tools like read, grep)
    if (participant.runtime) {
      let content = '';
      const input: AgentInput = { prompt: `${history}\n\n---\n진행자가 발언을 요청했습니다. 응답하세요.` };
      for await (const event of participant.runtime.execute(input)) {
        if (event.type === 'tool_call') this.emit({ type: 'tool_call', name: event.name, input: event.input as Record<string, unknown>, agent: agentName });
        else if (event.type === 'tool_result') this.emit({ type: 'tool_result', name: event.name, isError: event.isError, agent: agentName });
        else if (event.type === 'done') content = event.content;
      }
      if (content) {
        this.mgr.speak(meeting.id, agentName, content);
        this.emit({ type: 'text', text: content, agent: agentName });
      }
      return;
    }

    // LLM fallback
    const text = await this.agentSay(agentName,
      `${history}\n\n---\n진행자가 발언을 요청했습니다. 응답하세요. 짧고 핵심적으로.`);
    if (text && text !== 'PASS' && !text.includes('mock agent')) {
      this.mgr.speak(meeting.id, agentName, text);
      this.emit({ type: 'text', text, agent: agentName });
    }
  }

  /** Simple LLM call for an agent */
  private async agentSay(agentName: string, prompt: string): Promise<string> {
    const participant = this.room.getParticipant(agentName);
    if (!participant) return '';
    const resp = await participant.llm.complete(
      [{ role: 'user', content: prompt }] as LLMMessage[],
      { systemPrompt: participant.respondPrompt ?? participant.card.description, maxTokens: this.maxTokens },
    );
    return resp.content.trim();
  }
}
