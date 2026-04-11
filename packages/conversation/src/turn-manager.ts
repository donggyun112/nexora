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

// R1 FIX: previous version interpolated primary agent's response into the
// system prompt, which let a malicious primary inject instructions at system
// priority. Now the system prompt only contains the agent's own identity;
// the primary response is passed as an assistant message in the conversation
// history where it cannot override system-level instructions.
const FOLLOW_UP_SYSTEM_TEMPLATE = `You are {agentName} — {description}.

Another agent already responded to the user's latest message.
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
  /**
   * Per-room mutex: serializes turns so overlapping messages don't interleave
   * on the shared history. Key = room.id. The value is the tail of a promise
   * chain — each new turn awaits the previous one before starting.
   */
  private readonly roomLocks = new Map<string, Promise<void>>();

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
    // Serialize turns per room so concurrent messages don't interleave on
    // the shared history. Each turn awaits the previous one. If the previous
    // turn threw, we still proceed (the lock chain uses .catch(() => {})).
    const prev = this.roomLocks.get(room.id) ?? Promise.resolve();
    let releaseLock: () => void = () => {};
    const lock = new Promise<void>(resolve => { releaseLock = resolve; });
    this.roomLocks.set(room.id, prev.catch(() => {}).then(() => lock));
    await prev.catch(() => {}); // wait for previous turn to finish

    try {
      return await this.handleMessageUnsafe(room, message);
    } finally {
      room.activeResponder = null; // always clean up
      releaseLock();
    }
  }

  /** The actual turn logic, called under the per-room lock. */
  private async handleMessageUnsafe(
    room: ConversationRoom,
    message: RoomMessage,
  ): Promise<TurnResult> {
    const participants = room.agents();
    if (participants.length === 0) {
      return { responses: [], evaluations: [] };
    }

    // MESSAGE OWNERSHIP: handleMessage is the single authority that adds the
    // user message to room history. Callers must NOT call room.addMessage()
    // before this — if they did, history would contain the message twice,
    // biasing the evaluate phase and bloating the prompt.
    // We check for duplicates: if the last message in history has the same
    // content and sender, skip the insert (idempotent).
    const lastMsg = room.history()[room.length - 1];
    const isDuplicate = lastMsg
      && lastMsg.sender === message.sender
      && lastMsg.content === message.content
      && Math.abs(lastMsg.timestamp - message.timestamp) < 1000;
    if (!isDuplicate) {
      room.addMessage(message);
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

    // Phase 3: PRIMARY responds (with failover to standby if primary throws)
    let primaryIdx = 0;
    let primaryContent: string | null = null;
    let primaryAgentName: string | null = null;

    while (primaryIdx < willing.length && primaryContent === null) {
      const candidate = willing[primaryIdx];
      const participant = room.getParticipant(candidate.agentName);
      if (!participant) { primaryIdx++; continue; }

      this.onBeforeRespond?.(candidate.agentName, 'primary');
      room.activeResponder = candidate.agentName;

      try {
        primaryContent = await this.generateResponse(participant, history);
        primaryAgentName = candidate.agentName;
      } catch {
        // Primary LLM failed — try next standby as primary (failover).
        room.activeResponder = null;
        primaryIdx++;
      }
    }

    if (primaryContent === null || primaryAgentName === null) {
      // All willing agents failed — run fallback
      room.activeResponder = null;
      const fallback = await this.onNoVolunteer(room, message);
      if (fallback) {
        room.addAgentMessage('system', fallback);
        responses.push({ agentName: 'system', content: fallback, phase: 'fallback' });
      }
      return { responses, evaluations };
    }

    room.addAgentMessage(primaryAgentName, primaryContent);
    room.activeResponder = null;
    responses.push({
      agentName: primaryAgentName,
      content: primaryContent,
      phase: 'primary',
    });

    // Phase 4: FOLLOW-UPS (skip agents that already tried as primary)
    const standby = willing
      .slice(primaryIdx + 1, primaryIdx + this.maxResponders)
      .filter(e => e.confidence >= this.followUpMinConfidence);

    for (const candidate of standby) {
      const participant = room.getParticipant(candidate.agentName);
      if (!participant) continue;

      this.onBeforeRespond?.(candidate.agentName, 'follow-up');
      room.activeResponder = candidate.agentName;

      try {
        const followUpContent = await this.generateFollowUp(
          participant,
          message,
          primaryAgentName,
          primaryContent,
          room.historyForLLM(),
        );

        room.activeResponder = null;

        if (!followUpContent || followUpContent.trim().toUpperCase() === 'PASS') {
          continue;
        }

        room.addAgentMessage(candidate.agentName, followUpContent);
        responses.push({
          agentName: candidate.agentName,
          content: followUpContent,
          phase: 'follow-up',
        });
      } catch {
        // Follow-up LLM failed — skip this agent, don't kill the turn.
        room.activeResponder = null;
      }
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
    _userMessage: RoomMessage,
    _primaryAgent: string,
    _primaryResponse: string,
    history: { role: 'user' | 'assistant'; content: string }[],
  ): Promise<string | null> {
    // R1 FIX: system prompt no longer contains the primary response or user
    // message as interpolated strings. The history already has both — the
    // primary's response was added via room.addAgentMessage(), and the user
    // message was added at the top of handleMessage(). The LLM sees them as
    // normal conversation turns, not as system-level instructions.
    const systemPrompt = FOLLOW_UP_SYSTEM_TEMPLATE
      .replace('{agentName}', participant.card.name)
      .replace('{description}', participant.card.description);

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
