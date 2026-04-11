/**
 * ConversationRoom — shared context for multi-agent group conversation.
 *
 * A Room is a logical space (like a Slack channel or Discord thread) where
 * one or more humans and multiple agents share a conversation. Every
 * participant sees the same history, and the TurnManager uses the Room's
 * state to coordinate who speaks when.
 *
 * The Room is NOT a transport primitive — it doesn't send or receive
 * messages. It's a state container that the TurnManager reads and writes.
 * The actual I/O is handled by the adapter (Discord, Slack, HTTP) that
 * feeds messages into the Room and posts agent responses out.
 */

import type { AgentCard, LLMProvider } from '@nexora/contracts';

export interface RoomMessage {
  /** Who sent the message. 'user' for humans, agent name for agents. */
  sender: string;
  /** The role for LLM context: 'user' for humans, 'assistant' for agents. */
  role: 'user' | 'assistant';
  /** Text content. */
  content: string;
  /** When the message was added. */
  timestamp: number;
  /** If sent by an agent, which one. */
  agentName?: string;
}

export interface RoomParticipant {
  card: AgentCard;
  /**
   * The LLM used for this agent's evaluate + respond phases.
   * Evaluate uses it with ~50 tokens. Respond uses it with the full budget.
   * Different agents can use different models (e.g. cheap model for triage,
   * expensive model for code review).
   */
  llm: LLMProvider;
  /**
   * Optional custom system prompt for this agent's evaluate phase.
   * If not set, the TurnManager builds one from the card's description.
   */
  evaluatePrompt?: string;
  /**
   * Optional custom system prompt for this agent's respond phase.
   * If not set, uses the card's description as persona.
   */
  respondPrompt?: string;
}

export class ConversationRoom {
  readonly id: string;
  private readonly participants = new Map<string, RoomParticipant>();
  private readonly messages: RoomMessage[] = [];
  private _activeResponder: string | null = null;

  constructor(id: string) {
    this.id = id;
  }

  /** Add an agent to the room. */
  join(participant: RoomParticipant): void {
    this.participants.set(participant.card.name, participant);
  }

  /** Remove an agent from the room. */
  leave(agentName: string): void {
    this.participants.delete(agentName);
  }

  /** All currently-joined agents. */
  agents(): RoomParticipant[] {
    return Array.from(this.participants.values());
  }

  /** Agent names for context. */
  agentNames(): string[] {
    return Array.from(this.participants.keys());
  }

  /** Get a specific participant. */
  getParticipant(name: string): RoomParticipant | undefined {
    return this.participants.get(name);
  }

  /** Add a message to the shared history. */
  addMessage(msg: RoomMessage): void {
    this.messages.push(msg);
  }

  /** Add a user message (convenience). */
  addUserMessage(content: string, sender = 'user'): RoomMessage {
    const msg: RoomMessage = {
      sender,
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    this.messages.push(msg);
    return msg;
  }

  /** Add an agent message (convenience). */
  addAgentMessage(agentName: string, content: string): RoomMessage {
    const msg: RoomMessage = {
      sender: agentName,
      role: 'assistant',
      content,
      timestamp: Date.now(),
      agentName,
    };
    this.messages.push(msg);
    return msg;
  }

  /** Full conversation history, shared by all participants. */
  history(): RoomMessage[] {
    return [...this.messages];
  }

  /** Convert history to LLM message format. */
  historyForLLM(): { role: 'user' | 'assistant'; content: string }[] {
    return this.messages.map(m => ({
      role: m.role,
      content: m.agentName
        ? `[${m.agentName}]: ${m.content}`
        : m.content,
    }));
  }

  /** Which agent is currently generating a response (null = nobody). */
  get activeResponder(): string | null {
    return this._activeResponder;
  }

  set activeResponder(name: string | null) {
    this._activeResponder = name;
  }

  /** Number of messages. */
  get length(): number {
    return this.messages.length;
  }
}
