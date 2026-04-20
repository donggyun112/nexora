/**
 * Evaluate — ultra-lightweight "should I respond?" decision.
 *
 * Each agent runs this BEFORE committing to a full response. The goal is
 * a fast binary decision (yes/no) + confidence score (0-1) using ~50 tokens.
 * At GPT-4o-mini pricing this costs ~$0.00001 per evaluation, so running
 * it on 5 agents per message costs effectively nothing.
 *
 * The evaluate prompt is carefully designed to:
 *   - Tell the agent who else is in the room (so it can yield)
 *   - Remind it that silence is better than noise
 *   - Ask for a JSON response (fast to parse)
 *   - Cap at 80 tokens to keep latency < 500ms
 */

import type { LLMProvider, LLMMessage } from '@nexora/contracts';
import type { RoomMessage, RoomParticipant } from './room.js';

export interface EvaluationResult {
  agentName: string;
  respond: boolean;
  confidence: number;
  reason: string;
}

const EVALUATE_SYSTEM_TEMPLATE = `You are {agentName} — {description}.

You are in a group conversation with these other agents: {otherAgents}.

A new message just arrived. Decide if YOU should respond.

Rules:
- If @{agentName} is mentioned by name → respond = true, confidence = 1.0
- If this is clearly YOUR expertise → respond = true, high confidence
- If another agent is better suited → respond = false
- If you are unsure → respond = false (silence > noise)
- NEVER plan to repeat what another agent already said
- Consider the full conversation history, not just the last message

Output ONLY a JSON object: {"respond": bool, "confidence": 0.0-1.0, "reason": "one sentence"}`;

/**
 * Run the evaluate phase for a single agent.
 * Returns quickly (~50 tokens, ~200-500ms).
 */
/** Default per-agent evaluate timeout (ms). */
const DEFAULT_EVALUATE_TIMEOUT_MS = 10_000;

export async function evaluateAgent(
  participant: RoomParticipant,
  newMessage: RoomMessage,
  history: { role: 'user' | 'assistant'; content: string }[],
  otherAgentNames: string[],
  evaluateTimeoutMs: number = DEFAULT_EVALUATE_TIMEOUT_MS,
): Promise<EvaluationResult> {
  // R5 SHORT-CIRCUIT: if the message @mentions this agent by name, skip the
  // LLM call entirely. We know confidence=1.0 and the answer is "yes".
  // This saves ~200-500ms and $0.00001 per mentioned agent.
  if (newMessage.content.includes(`@${participant.card.name}`)) {
    return {
      agentName: participant.card.name,
      respond: true,
      confidence: 1.0,
      reason: 'directly mentioned (short-circuited, no LLM call)',
    };
  }

  const systemPrompt = participant.evaluatePrompt
    ?? EVALUATE_SYSTEM_TEMPLATE
      .replace(/{agentName}/g, participant.card.name)
      .replace('{description}', participant.card.description)
      .replace('{otherAgents}', otherAgentNames.join(', ') || '(none)');

  const messages: LLMMessage[] = [
    ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    { role: 'user' as const, content: newMessage.content },
  ];

  try {
    // R5: per-agent timeout so one slow agent doesn't block the entire
    // evaluate phase. If the timeout fires, we treat it as a pass.
    const response = await Promise.race([
      participant.llm.complete(messages, {
        systemPrompt,
        maxTokens: 80,
        temperature: 0,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('evaluate timeout')), evaluateTimeoutMs),
      ),
    ]);

    return parseEvaluation(participant.card.name, response.content, newMessage);
  } catch {
    // On LLM failure or timeout, default to not responding (safe).
    return {
      agentName: participant.card.name,
      respond: false,
      confidence: 0,
      reason: 'evaluate failed or timed out',
    };
  }
}

/**
 * Run evaluate on ALL agents in parallel. Returns sorted by confidence desc.
 */
export async function evaluateAll(
  participants: RoomParticipant[],
  newMessage: RoomMessage,
  history: { role: 'user' | 'assistant'; content: string }[],
): Promise<EvaluationResult[]> {
  const results = await Promise.all(
    participants.map(p => {
      const others = participants
        .filter(o => o.card.name !== p.card.name)
        .map(o => o.card.name);
      return evaluateAgent(p, newMessage, history, others);
    }),
  );

  return results.sort((a, b) => b.confidence - a.confidence);
}

function parseEvaluation(
  agentName: string,
  content: string,
  _message: RoomMessage,
): EvaluationResult {
  // @mention is handled by the short-circuit in evaluateAgent() above.
  // By the time we reach parseEvaluation, the LLM has already run, so
  // we just parse its output.

  try {
    const cleaned = content.trim().replace(/^```(?:json)?\n?|\n?```$/g, '');
    const parsed = JSON.parse(cleaned) as {
      respond?: boolean;
      confidence?: number;
      reason?: string;
    };
    return {
      agentName,
      respond: parsed.respond === true,
      confidence: typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0,
      reason: parsed.reason ?? '',
    };
  } catch {
    // Couldn't parse JSON — look for heuristic signals
    const lower = content.toLowerCase();
    const respond = lower.includes('"respond": true') || lower.includes('"respond":true');
    return {
      agentName,
      respond,
      confidence: respond ? 0.5 : 0,
      reason: '(parsed heuristically)',
    };
  }
}
