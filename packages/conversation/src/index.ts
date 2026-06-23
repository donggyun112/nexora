// ─── Conversation: 멀티 에이전트 그룹 대화 턴테이킹 프로토콜 ─────────────────
//
// 여러 에이전트가 한 사람과 한 채널을 공유할 때, 모두 동시에 답하지 않고
// 사람처럼 순서를 지키게 한다.
//
// 섹션 맵 (에이전트용: 무엇이 어느 파일에 있는지 — 정확한 타입은 해당 파일을 signatures 모드로)
//   Room          ./room          ConversationRoom, RoomParticipant, RoomMessage
//   Turn 프로토콜 ./turn-manager  TurnManager (evaluate→select→respond→follow-up), TurnResult
//   Evaluate      ./evaluate      evaluateAgent, evaluateAll ("내가 답할까?" 판단), EvaluationResult
//   Meeting 진행  ./meeting-orchestrator  MeetingOrchestrator, MeetingEvent
//   Meeting 프롬프트 ./meeting-prompts    DEFAULT_MEETING_PROMPTS, interpolate, MeetingPromptTemplates
//
// 새 모듈을 export하면 여기 한 줄 추가. API 설명은 각 파일 TSDoc이 정본 — 위는 위치 안내만.

export { ConversationRoom } from './room.js';
export type { RoomMessage, RoomParticipant, ConversationRoomOptions } from './room.js';

export { TurnManager } from './turn-manager.js';
export type { TurnManagerOptions, TurnResult } from './turn-manager.js';

export { evaluateAgent, evaluateAll } from './evaluate.js';
export type { EvaluationResult } from './evaluate.js';

export { MeetingOrchestrator } from './meeting-orchestrator.js';
export type { MeetingEvent, MeetingOrchestratorOptions } from './meeting-orchestrator.js';

export { DEFAULT_MEETING_PROMPTS, interpolate } from './meeting-prompts.js';
export type { MeetingPromptTemplates } from './meeting-prompts.js';
