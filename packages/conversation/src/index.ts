/**
 * @nexora/conversation — multi-agent group conversation protocol.
 *
 * When multiple agents share a channel with a human, this package provides
 * the turn-taking protocol that makes them behave like people in a group
 * chat instead of all answering at once.
 *
 * Core components:
 *   - ConversationRoom: shared state (participants, history, active responder)
 *   - TurnManager: the 4-phase protocol (evaluate → select → respond → follow-up)
 *   - evaluateAgent / evaluateAll: ultra-cheap "should I respond?" LLM calls
 */

export { ConversationRoom } from './room.js';
export type { RoomMessage, RoomParticipant } from './room.js';

export { TurnManager } from './turn-manager.js';
export type { TurnManagerOptions, TurnResult } from './turn-manager.js';

export { evaluateAgent, evaluateAll } from './evaluate.js';
export type { EvaluationResult } from './evaluate.js';
