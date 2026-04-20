/**
 * MeetingPromptTemplates — configurable prompt system for MeetingOrchestrator.
 *
 * Framework users override any template via MeetingOrchestratorOptions.prompts.
 * Variables use {varName} syntax, interpolated at runtime.
 *
 * This file contains NO business logic — only the contract and defaults.
 */

// ─── Interpolation ──────────────────────────────────────────────────────

/** Replace {varName} placeholders with values from vars. Unresolved vars are left as-is. */
export function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const val = vars[key];
    return val !== undefined ? String(val) : match;
  });
}

// ─── Template Interface ─────────────────────────────────────────────────

export interface MeetingPromptTemplates {
  // ── System messages ──
  /** Shown when a meeting is already active. */
  meetingBusy: string;

  // ── Opening ──
  /** Simple meeting opening. Vars: {topic}, {participants} */
  openingSimple: string;
  /** Stream meeting opening. Vars: {topic} */
  openingStream: string;

  // ── Topic detection ──
  /** Regex to detect research-type topics. */
  researchTopicPattern: RegExp | string;
  /** Goal description for research topics. Vars: {topic} */
  researchGoal: string;
  /** Goal description for decision topics. Vars: {topic} */
  decisionGoal: string;

  // ── Speaker prompts ──
  /** Identity prefix. Vars: {agentName}, {others} */
  identity: string;
  /** Reply context when called by another agent. Vars: {caller} */
  replyContext: string;
  /** Topic anchor. Vars: {goalDesc} */
  topicAnchor: string;
  /** Rules appended to every speaker prompt. */
  rules: string;
  /** First speaker instruction. Vars: {agentName}, {others} */
  firstSpeak: string;
  /** Continuation speaker instruction. Vars: {others} */
  continueSpeak: string;

  // ── Moderator ──
  /** Moderator system prompt (separate persona from participant). */
  moderatorPersona: string;
  /** Moderator check prompt. Vars: {history}, {interactionCount}, {completedRounds}, {msgCount} */
  moderatorCheck: string;

  // ── Conclude ──
  /** Simple conclude check. Vars: {history} */
  simpleConcludeCheck: string;
  /** Summary request. Vars: {history} */
  concludeSummary: string;
  /** Summary proposal for objection phase. Vars: {history} */
  summaryProposal: string;
  /** Objection check per participant. Vars: {agentName}, {history} */
  objectionCheck: string;
  /** Master decision after objections. Vars: {history}, {voteLabel}, {objSummary}, {recommendation} */
  masterDecision: string;

  // ── Stimulation ──
  /** Force cross-discussion. Vars: {history}, {leastActive} */
  forceStimulation: string;
  /** Insufficient interaction. Vars: {history}, {interactionCount} */
  insufficientInteraction: string;
  /** General stimulation. Vars: {history} */
  generalStimulation: string;

  // ── Thread ──
  /** Thread continuation. Vars: {history} */
  threadContinue: string;
  /** Stale thread conclusion. */
  threadStaleConclusion: string;

  // ── Tool / Evaluate ──
  /** Re-prompt after tool execution. */
  toolResultReprompt: string;
  /** Evaluate who speaks. Vars: {history} */
  evaluateWhoSpeaks: string;
}

// ─── Default Templates ──────────────────────────────────────────────────

export const DEFAULT_MEETING_PROMPTS: MeetingPromptTemplates = {
  // System
  meetingBusy: 'Another meeting is already in progress.',

  // Opening
  openingSimple: 'Meeting topic: "{topic}". Participants: {participants}. Begin briefly.',
  openingStream: '[Meeting topic: {topic}] Please share your opinions.',

  // Topic detection
  researchTopicPattern: /what|how|why|mechanism|phenomenon|무엇|어떤|왜|인가|있는가|현상|원리|메커니즘/i,
  researchGoal: 'This is a research discussion. Analyze the topic "{topic}" — causes, mechanisms, possible approaches. Do not create implementation plans or schedules.',
  decisionGoal: 'Derive a concrete answer for: "{topic}".',

  // Speaker
  identity: '[You are "{agentName}". Other participants: {others}.]\n',
  replyContext: '\n[⚡ {caller} called you. Address their point first.]\n',
  topicAnchor: '[Meeting goal: {goalDesc}]\n\n',
  rules: [
    'Rules:',
    '- Proceed with available information. No deferring.',
    '- Address the intended recipient directly via "to". No relaying through others.',
    '- The "to" field must match the person you are asking/addressing in your message.',
  ].join('\n'),
  firstSpeak: 'Use the speak tool to present your perspective as {agentName}.\nSet "to" to the next speaker ({others}).',
  continueSpeak: 'Use the speak tool to advance toward an answer.\n- Build on or supplement previous statements.\n- Set "to" to the next speaker ({others}).',

  // Moderator
  moderatorPersona: [
    'You are a neutral meeting moderator. Judge from a third-party perspective, not as a participant.',
    '- Verify all participants have spoken sufficiently.',
    '- Check for cross-discussion (challenges, supplements) between participants.',
    '- If only one-sided presentations occurred without cross-discussion, it is not enough.',
    '- Do not close because "everyone spoke at length" — close only when genuine consensus or thorough debate has occurred.',
  ].join('\n'),

  moderatorCheck: [
    '{history}',
    '',
    '---',
    '[Cross-discussion: {interactionCount} exchanges, rounds: {completedRounds}, total messages: {msgCount}]',
    '',
    'Decide in one word only:',
    '- No intervention needed: "CONTINUE"',
    '- One-sided presentations, insufficient cross-discussion: "STIMULATE"',
    '- Sufficient discussion with cross-debate: "CONCLUDE"',
  ].join('\n'),

  // Conclude
  simpleConcludeCheck: '{history}\n\n---\nIf consensus reached: "CONCLUDE: [one-line conclusion]". Otherwise: "CONTINUE".',
  concludeSummary: '{history}\n\n---\nSummarize the meeting conclusion in one line.',
  summaryProposal: [
    '{history}',
    '',
    '---',
    'As moderator, summarize the discussion concisely via the speak tool (to: "everyone"):',
    '- Points of agreement',
    '- Remaining disagreements',
    '- Proposed conclusion',
    'End with: "Any objections?"',
  ].join('\n'),
  objectionCheck: '[You are "{agentName}".]\n\n{history}\n\n---\nThe moderator proposed a conclusion. If you object, use speak to challenge. If you agree, use pass_turn.',
  masterDecision: '{history}\n\n---\n{voteLabel}\nObjections:\n{objSummary}\n\n{recommendation}\nOne word only.',

  // Stimulation
  forceStimulation: '{history}\n\n---\nThe discussion has been one-sided presentations. Use speak to ask specific questions to {leastActive}. Set "to" to them.',
  insufficientInteraction: '{history}\n\n---\nCross-discussion is insufficient ({interactionCount} exchanges). Use speak to ask questions to participants who have not yet interacted with each other.',
  generalStimulation: '{history}\n\n---\nThe discussion has been one-sided. Use speak to stimulate cross-discussion between participants. Ask concrete questions and set "to" to specific people.',

  // Thread
  threadContinue: '{history}\n\n---\nContinue the conversation. On agreement: "AGREED: [agreement content]".',
  threadStaleConclusion: 'Additional information needed. Revisit after gathering data.',

  // Tool / Evaluate
  toolResultReprompt: 'Based on the tool result above, use the speak tool to make your statement.',
  evaluateWhoSpeaks: '{history}\n\n---\nRead the discussion above. Do you have a new perspective or rebuttal to add?\nRespond with JSON only: {"speak": true/false, "confidence": 0.0-1.0, "reason": "one sentence"}',
};
