/**
 * TurnManager — the conductor of multi-agent group conversation.
 *
 * When a new message arrives in a ConversationRoom, the TurnManager runs
 * the four-phase protocol that makes agents behave like people in a group
 * chat instead of all shouting at once:
 *
 *   Phase 1 — EVALUATE (parallel, cheap):
 *     Every agent in the room quickly decides "should I respond?" using
 *     ~50 tokens. Takes 0.2-1 second total.
 *
 *   Phase 2 — SELECT:
 *     The TurnManager picks the primary responder (highest confidence)
 *     and optionally standby agents who may add follow-ups.
 *
 *   Phase 3 — RESPOND:
 *     The primary agent generates a full response. This is the expensive
 *     step — full LLM reasoning, possibly tool calls.
 *
 *   Phase 4 — FOLLOW-UP (optional):
 *     Standby agents see the primary's response and decide if they have
 *     something to ADD (not repeat). If yes, they respond too.
 *
 * The result is a natural conversation where the most relevant agent speaks
 * first, others add when useful, and everyone else stays silent.
 */

import type { LLMMessage } from '@nexora/contracts';
import { ConversationRoom, type RoomMessage, type RoomParticipant } from './room.js';
import { evaluateAll, type EvaluationResult } from './evaluate.js';

export interface TurnManagerOptions {
  /**
   * Minimum confidence to be considered for responding. Default: 0.3.
   * Agents below this threshold are treated as "pass".
   */
  minConfidence?: number;
  /**
   * Maximum number of agents that can respond (primary + follow-ups).
   * Default: 3. Set to 1 for "only one agent per message" behavior.
   */
  maxResponders?: number;
  /**
   * Minimum confidence for a follow-up agent to actually post. Default: 0.5.
   * Higher than minConfidence because follow-ups should only happen when
   * the agent genuinely has something to ADD.
   */
  followUpMinConfidence?: number;
  /**
   * If no agent raises hand, call this fallback. Default: posts a generic
   * "I'm not sure how to help with that" message.
   */
  onNoVolunteer?: (room: ConversationRoom, message: RoomMessage) => Promise<string | null>;
  /**
   * Called whenever an agent is about to respond (for logging/tracing).
   */
  onBeforeRespond?: (agentName: string, phase: 'primary' | 'follow-up') => void;
}

export interface TurnResult {
  /** Which agents responded, in order. Empty if nobody volunteered. */
  responses: {
    agentName: string;
    content: string;
    phase: 'primary' | 'follow-up' | 'fallback';
  }[];
  /** The raw evaluations from phase 1, for debugging/tracing. */
  evaluations: EvaluationResult[];
}

const FOLLOW_UP_SYSTEM_TEMPLATE = `You are {agentName} — {description}.

The user asked: {userMessage}
Another agent ({primaryAgent}) already responded: {primaryResponse}

If you have something ADDITIONAL and DIFFERENT to contribute, respond concisely.
If the previous response already covers everything, output exactly: PASS

Rules:
- Do NOT repeat what was already said
- Only add genuinely new information or a different perspective
- Keep it brief — this is a follow-up, not a full response
- If in doubt, output PASS`;

export class TurnManager {
  private readonly minConfidence: number;
  private readonly maxResponders: number;
  private readonly followUpMinConfidence: number;
  private readonly onNoVolunteer: NonNullable<TurnManagerOptions['onNoVolunteer']>;
  private readonly onBeforeRespond?: TurnManagerOptions['onBeforeRespond'];

  constructor(options: TurnManagerOptions = {}) {
    this.minConfidence = options.minConfidence ?? 0.3;
    this.maxResponders = options.maxResponders ?? 3;
    this.followUpMinConfidence = options.followUpMinConfidence ?? 0.5;
    this.onNoVolunteer = options.onNoVolunteer ?? (async () => null);
    this.onBeforeRespond = options.onBeforeRespond;
  }

  /**
   * Handle a new user message. Runs the full 4-phase protocol and returns
   * the agent responses (which the adapter should post to the channel).
   */
  async handleMessage(
    room: ConversationRoom,
    message: RoomMessage,
  ): Promise<TurnResult> {
    const participants = room.agents();
    if (participants.length === 0) {
      return { responses: [], evaluations: [] };
    }

    // Phase 1: EVALUATE — all agents decide in parallel
    const history = room.historyForLLM();
    const evaluations = await evaluateAll(participants, message, history);

    // Phase 2: SELECT
    const willing = evaluations.filter(
      e => e.respond && e.confidence >= this.minConfidence,
    );

    const responses: TurnResult['responses'] = [];

    if (willing.length === 0) {
      // Nobody volunteered — run fallback
      const fallback = await this.onNoVolunteer(room, message);
      if (fallback) {
        room.addAgentMessage('system', fallback);
        responses.push({ agentName: 'system', content: fallback, phase: 'fallback' });
      }
      return { responses, evaluations };
    }

    // Phase 3: PRIMARY responds
    const primary = willing[0];
    const primaryParticipant = room.getParticipant(primary.agentName);
    if (!primaryParticipant) {
      return { responses, evaluations };
    }

    this.onBeforeRespond?.(primary.agentName, 'primary');
    room.activeResponder = primary.agentName;

    const primaryContent = await this.generateResponse(
      primaryParticipant,
      [...history, { role: 'user' as const, content: message.content }],
    );

    room.addAgentMessage(primary.agentName, primaryContent);
    room.activeResponder = null;
    responses.push({
      agentName: primary.agentName,
      content: primaryContent,
      phase: 'primary',
    });

    // Phase 4: FOLLOW-UPS
    const standby = willing
      .slice(1, this.maxResponders)
      .filter(e => e.confidence >= this.followUpMinConfidence);

    for (const candidate of standby) {
      const participant = room.getParticipant(candidate.agentName);
      if (!participant) continue;

      this.onBeforeRespond?.(candidate.agentName, 'follow-up');
      room.activeResponder = candidate.agentName;

      const followUpContent = await this.generateFollowUp(
        participant,
        message,
        primary.agentName,
        primaryContent,
        room.historyForLLM(),
      );

      room.activeResponder = null;

      // Agent said "PASS" — nothing to add.
      if (!followUpContent || followUpContent.trim().toUpperCase() === 'PASS') {
        continue;
      }

      room.addAgentMessage(candidate.agentName, followUpContent);
      responses.push({
        agentName: candidate.agentName,
        content: followUpContent,
        phase: 'follow-up',
      });
    }

    return { responses, evaluations };
  }

  private async generateResponse(
    participant: RoomParticipant,
    messages: { role: 'user' | 'assistant'; content: string }[],
  ): Promise<string> {
    const systemPrompt = participant.respondPrompt
      ?? `You are ${participant.card.name}. ${participant.card.description}. Be concise and helpful.`;

    const llmMessages: LLMMessage[] = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    const response = await participant.llm.complete(llmMessages, {
      systemPrompt,
    });

    return response.content;
  }

  private async generateFollowUp(
    participant: RoomParticipant,
    userMessage: RoomMessage,
    primaryAgent: string,
    primaryResponse: string,
    history: { role: 'user' | 'assistant'; content: string }[],
  ): Promise<string | null> {
    const systemPrompt = FOLLOW_UP_SYSTEM_TEMPLATE
      .replace('{agentName}', participant.card.name)
      .replace('{description}', participant.card.description)
      .replace('{userMessage}', userMessage.content)
      .replace('{primaryAgent}', primaryAgent)
      .replace('{primaryResponse}', primaryResponse);

    const llmMessages: LLMMessage[] = history.map(m => ({
      role: m.role,
      content: m.content,
    }));

    try {
      const response = await participant.llm.complete(llmMessages, {
        systemPrompt,
        maxTokens: 300,
      });
      return response.content;
    } catch {
      return null;
    }
  }
}
