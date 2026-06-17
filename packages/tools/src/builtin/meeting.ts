/**
 * Meeting tools — agents open meetings, speak, pass, conclude.
 *
 * open_meeting: creates a meeting room, caller becomes master
 * open_thread: 1:1 meeting with one other agent
 * speak: post a message in a meeting
 * pass: skip your turn
 * conclude: master ends the meeting with a summary
 * get_meeting: view meeting status and history
 */

import type { ToolDefinition, ToolResult } from '@dongkseo/contracts';
import { textResult, errorResult } from '@dongkseo/contracts';

// ─── Meeting state ──────────────────────────────────────────────────────

export interface MeetingMessage {
  agent: string;
  content: string;
  timestamp: number;
  /** Who this message was addressed to */
  to?: string[];
}

export interface Meeting {
  id: string;
  topic: string;
  master: string;
  participants: string[];
  /** Agents invited but not yet joined */
  invited: string[];
  messages: MeetingMessage[];
  status: 'active' | 'concluded';
  summary?: string;
  /** Agents who raised their hand (want to speak next) */
  handRaised: string[];
}

export type MeetingSpeakListener = (meetingId: string, agent: string, content: string) => void;

export class MeetingManager {
  private meetings = new Map<string, Meeting>();
  private nextId = 1;
  private speakListeners: MeetingSpeakListener[] = [];

  /** Subscribe to new messages in any active meeting. */
  onSpeak(listener: MeetingSpeakListener): () => void {
    this.speakListeners.push(listener);
    return () => { this.speakListeners = this.speakListeners.filter(l => l !== listener); };
  }

  open(master: string, topic: string, participants: string[]): Meeting | null {
    if (this.listActive().length > 0) return null;
    // Filter to only known participants (registered in any previous meeting or explicitly allowed)
    const allParticipants = [master];
    const meeting: Meeting = {
      id: `meeting-${this.nextId++}`,
      topic,
      master,
      participants: allParticipants,
      invited: participants.filter(p => p !== master),
      messages: [],
      status: 'active',
      handRaised: [],
    };
    this.meetings.set(meeting.id, meeting);
    return meeting;
  }

  join(id: string, agent: string): boolean {
    const m = this.meetings.get(id);
    if (!m || m.status !== 'active') return false;
    if (!m.invited.includes(agent)) return false;
    if (m.participants.includes(agent)) return false;
    m.participants.push(agent);
    m.invited = m.invited.filter(a => a !== agent);
    return true;
  }

  get(id: string): Meeting | undefined {
    return this.meetings.get(id);
  }

  speak(id: string, agent: string, content: string, to?: string[]): MeetingMessage | null {
    const m = this.meetings.get(id);
    if (!m || m.status !== 'active') return null;
    if (!m.participants.includes(agent)) return null;
    const msg: MeetingMessage = { agent, content, timestamp: Date.now(), to };
    m.messages.push(msg);
    // Notify listeners (for async event-based agents)
    for (const fn of this.speakListeners) { try { fn(id, agent, content); } catch {} }
    return msg;
  }

  conclude(id: string, agent: string, summary: string): boolean {
    const m = this.meetings.get(id);
    if (!m || m.status !== 'active') return false;
    if (m.master !== agent) return false;
    m.status = 'concluded';
    m.summary = summary;
    return true;
  }

  raiseHand(id: string, agent: string): boolean {
    const m = this.meetings.get(id);
    if (!m || m.status !== 'active' || !m.participants.includes(agent)) return false;
    if (!m.handRaised.includes(agent)) m.handRaised.push(agent);
    return true;
  }

  /** Get next speaker (first in hand-raised queue), removes from queue */
  nextSpeaker(id: string): string | null {
    const m = this.meetings.get(id);
    if (!m || m.handRaised.length === 0) return null;
    return m.handRaised.shift()!;
  }

  /** Get who has their hand raised */
  getHandsRaised(id: string): string[] {
    return this.meetings.get(id)?.handRaised ?? [];
  }

  /** Format meeting history for LLM context */
  formatHistory(id: string): string {
    const m = this.meetings.get(id);
    if (!m) return '';
    const lines = [`📋 Meeting: ${m.topic} (${m.status})`, `Master: ${m.master}`, `Participants: ${m.participants.join(', ')}`, ...(m.invited.length ? [`Invited (not joined): ${m.invited.join(', ')}`] : []), ...(m.handRaised.length ? [`🙋 Hands raised: ${m.handRaised.join(', ')}`] : []), '---'];
    for (const msg of m.messages) {
      const toLabel = msg.to?.length ? ` → @${msg.to.join(', @')}` : '';
      lines.push(`[${msg.agent}${toLabel}]: ${msg.content}`);
    }
    if (m.summary) lines.push('---', `Summary: ${m.summary}`);
    return lines.join('\n');
  }

  listActive(): Meeting[] {
    return [...this.meetings.values()].filter(m => m.status === 'active');
  }

  /** Is this agent currently in an active meeting? */
  isInMeeting(agent: string): boolean {
    return this.listActive().some(m => m.participants.includes(agent));
  }

  /** Is this agent the master of an active meeting? */
  isMaster(agent: string): boolean {
    return this.listActive().some(m => m.master === agent);
  }

  /** Is this agent invited to an active meeting but hasn't joined? */
  isInvited(agent: string): boolean {
    return this.listActive().some(m => m.invited.includes(agent));
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────

export function createMeetingTools(manager: MeetingManager, agentName: string): ToolDefinition[] {
  const openMeeting: ToolDefinition = {
    name: 'open_meeting',
    description: 'Open a meeting room. You become the master (moderator). Other agents join as participants. Master can conclude the meeting.',
    checkAvailability: () => manager.listActive().length === 0,
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Meeting topic' },
        participants: { type: 'array', items: { type: 'string' }, description: 'Agent names to invite (e.g. ["coder", "researcher"])' },
      },
      required: ['topic', 'participants'],
    },
    execute: async (_callId, input): Promise<ToolResult> => {
      const { topic, participants } = input as { topic: string; participants: string[] };
      const meeting = manager.open(agentName, topic, participants);
      if (!meeting) return errorResult('Cannot open meeting: another meeting is already active');
      return textResult(`Meeting opened: ${meeting.id}\nTopic: ${topic}\nMaster: ${agentName}\nInvited: ${participants.join(', ')}\n\n[STOP] 회의가 열렸습니다. 더 이상 도구를 호출하지 마세요. 오케스트레이터가 회의를 진행합니다. 사용자에게 회의가 시작되었다고 간단히 알려주세요.`);
    },
  };

  const openThread: ToolDefinition = {
    name: 'open_thread',
    description: 'Open a 1:1 private thread with another agent. You become the master.',
    checkAvailability: () => manager.listActive().length === 0,
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent to invite (e.g. "coder")' },
        topic: { type: 'string', description: 'Thread topic' },
      },
      required: ['agent', 'topic'],
    },
    execute: async (_callId, input): Promise<ToolResult> => {
      const { agent, topic } = input as { agent: string; topic: string };
      const meeting = manager.open(agentName, topic, [agent]);
      if (!meeting) return errorResult('Cannot open thread: another meeting is already active');
      return textResult(`Thread opened: ${meeting.id}\nWith: ${agent}\nTopic: ${topic}\n\n[STOP] 스레드가 열렸습니다. 더 이상 도구를 호출하지 마세요. 오케스트레이터가 진행합니다.`);
    },
  };

  const joinMeeting: ToolDefinition = {
    name: 'join_meeting',
    description: 'Join a meeting you were invited to.',
    checkAvailability: () => manager.isInvited(agentName),
    parameters: {
      type: 'object',
      properties: { meetingId: { type: 'string', description: 'Meeting ID' } },
      required: ['meetingId'],
    },
    execute: async (_callId, input): Promise<ToolResult> => {
      const { meetingId } = input as { meetingId: string };
      if (!manager.join(meetingId, agentName)) return errorResult('Cannot join: not invited, already joined, or meeting not found');
      return textResult(`[${agentName}] joined ${meetingId}`);
    },
  };

  const speak: ToolDefinition = {
    name: 'speak',
    description: 'Post a message in an active meeting.',
    checkAvailability: () => manager.isInMeeting(agentName),
    parameters: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'Meeting ID' },
        message: { type: 'string', description: 'Your message' },
      },
      required: ['meetingId', 'message'],
    },
    execute: async (_callId, input): Promise<ToolResult> => {
      const { meetingId, message } = input as { meetingId: string; message: string };
      const msg = manager.speak(meetingId, agentName, message);
      if (!msg) return errorResult('Cannot speak: meeting not found, concluded, or you are not a participant');
      return textResult(`[${agentName}] spoke in ${meetingId}`);
    },
  };

  const pass: ToolDefinition = {
    name: 'pass_turn',
    description: 'Skip your turn in a meeting. Use when you have nothing to add.',
    checkAvailability: () => manager.isInMeeting(agentName),
    parameters: {
      type: 'object',
      properties: { meetingId: { type: 'string', description: 'Meeting ID' } },
      required: ['meetingId'],
    },
    execute: async (_callId, input): Promise<ToolResult> => {
      const { meetingId } = input as { meetingId: string };
      manager.speak(meetingId, agentName, 'PASS');
      return textResult(`[${agentName}] passed in ${meetingId}`);
    },
  };

  const raiseHand: ToolDefinition = {
    name: 'raise_hand',
    description: 'Raise your hand to request a turn to speak in a meeting. The master will call on you.',
    checkAvailability: () => manager.isInMeeting(agentName),
    parameters: {
      type: 'object',
      properties: { meetingId: { type: 'string', description: 'Meeting ID' } },
      required: ['meetingId'],
    },
    execute: async (_callId, input): Promise<ToolResult> => {
      const { meetingId } = input as { meetingId: string };
      if (!manager.raiseHand(meetingId, agentName)) return errorResult('Cannot raise hand');
      return textResult(`[${agentName}] raised hand in ${meetingId}`);
    },
  };

  const conclude: ToolDefinition = {
    name: 'conclude_meeting',
    description: 'End a meeting with a summary. Only the master (who opened the meeting) can conclude.',
    checkAvailability: () => manager.isMaster(agentName),
    parameters: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'Meeting ID' },
        summary: { type: 'string', description: 'Meeting summary/conclusion' },
      },
      required: ['meetingId', 'summary'],
    },
    execute: async (_callId, input): Promise<ToolResult> => {
      const { meetingId, summary } = input as { meetingId: string; summary: string };
      if (!manager.conclude(meetingId, agentName, summary)) {
        return errorResult('Cannot conclude: not the master, meeting not found, or already concluded');
      }
      return textResult(`Meeting ${meetingId} concluded.\nSummary: ${summary}`);
    },
  };

  const getMeeting: ToolDefinition = {
    name: 'get_meeting',
    description: 'View meeting status, participants, and conversation history.',
    checkAvailability: () => manager.isInMeeting(agentName),
    parameters: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'Meeting ID' },
      },
      required: ['meetingId'],
    },
    isReadOnly: true,
    execute: async (_callId, input): Promise<ToolResult> => {
      const { meetingId } = input as { meetingId: string };
      const text = manager.formatHistory(meetingId);
      return text ? textResult(text) : errorResult('Meeting not found');
    },
  };

  return [openMeeting, openThread, joinMeeting, speak, pass, raiseHand, conclude, getMeeting];
}
