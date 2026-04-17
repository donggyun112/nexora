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

import type { ToolDefinition, ToolResult } from '@nexora/contracts';
import { textResult, errorResult } from '@nexora/contracts';

// ─── Meeting state ──────────────────────────────────────────────────────

export interface MeetingMessage {
  agent: string;
  content: string;
  timestamp: number;
}

export interface Meeting {
  id: string;
  topic: string;
  master: string;
  participants: string[];
  messages: MeetingMessage[];
  status: 'active' | 'concluded';
  summary?: string;
}

export class MeetingManager {
  private meetings = new Map<string, Meeting>();
  private nextId = 1;

  open(master: string, topic: string, participants: string[]): Meeting {
    const allParticipants = [master, ...participants.filter(p => p !== master)];
    const meeting: Meeting = {
      id: `meeting-${this.nextId++}`,
      topic,
      master,
      participants: allParticipants,
      messages: [],
      status: 'active',
    };
    this.meetings.set(meeting.id, meeting);
    return meeting;
  }

  get(id: string): Meeting | undefined {
    return this.meetings.get(id);
  }

  speak(id: string, agent: string, content: string): MeetingMessage | null {
    const m = this.meetings.get(id);
    if (!m || m.status !== 'active') return null;
    if (!m.participants.includes(agent)) return null;
    const msg: MeetingMessage = { agent, content, timestamp: Date.now() };
    m.messages.push(msg);
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

  /** Format meeting history for LLM context */
  formatHistory(id: string): string {
    const m = this.meetings.get(id);
    if (!m) return '';
    const lines = [`📋 Meeting: ${m.topic} (${m.status})`, `Master: ${m.master}`, `Participants: ${m.participants.join(', ')}`, '---'];
    for (const msg of m.messages) {
      lines.push(`[${msg.agent}]: ${msg.content}`);
    }
    if (m.summary) lines.push('---', `Summary: ${m.summary}`);
    return lines.join('\n');
  }

  listActive(): Meeting[] {
    return [...this.meetings.values()].filter(m => m.status === 'active');
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────

export function createMeetingTools(manager: MeetingManager, agentName: string): ToolDefinition[] {
  const openMeeting: ToolDefinition = {
    name: 'open_meeting',
    description: 'Open a meeting room. You become the master (moderator). Other agents join as participants. Master can conclude the meeting.',
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
      return textResult(`Meeting opened: ${meeting.id}\nTopic: ${topic}\nMaster: ${agentName}\nParticipants: ${meeting.participants.join(', ')}`);
    },
  };

  const openThread: ToolDefinition = {
    name: 'open_thread',
    description: 'Open a 1:1 private thread with another agent. You become the master.',
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
      return textResult(`Thread opened: ${meeting.id}\nWith: ${agent}\nTopic: ${topic}`);
    },
  };

  const speak: ToolDefinition = {
    name: 'speak',
    description: 'Post a message in an active meeting.',
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
    parameters: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'Meeting ID' },
      },
      required: ['meetingId'],
    },
    execute: async (_callId, input): Promise<ToolResult> => {
      const { meetingId } = input as { meetingId: string };
      manager.speak(meetingId, agentName, 'PASS');
      return textResult(`[${agentName}] passed in ${meetingId}`);
    },
  };

  const conclude: ToolDefinition = {
    name: 'conclude_meeting',
    description: 'End a meeting with a summary. Only the master (who opened the meeting) can conclude.',
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

  return [openMeeting, openThread, speak, pass, conclude, getMeeting];
}
