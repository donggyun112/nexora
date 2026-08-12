// ─── Store-JSON: @dongkseo/store 백엔드 계약의 JSON 파일 구현 ──────────────
//
// 섹션 맵 (에이전트용: 무엇이 어느 파일에 있는지 — 정확한 타입은 해당 파일을 signatures 모드로)
//   Conversation   ./conversation    ConversationStoreJson        (선형 대화 기록)
//   Session tree   ./session-tree    TreeConversationStoreJson    (분기 가능한 세션 트리)
//   Transcript     ./transcript      TranscriptStoreJson          (ContentBlock 단위 기록)
//   Knowledge      ./knowledge        KnowledgeStoreJson
//   Schedule       ./schedule         ScheduleStoreJson
//   Context        ./context-store    ContextStoreJson
//   Audit          ./audit            AuditStoreJson
//   Tool context   ./tool-context     ToolContextStoreJson
//   Suspended turn ./suspended-turn   SuspendedTurnStoreJson       (HITL 일시중단 턴)
//   Effect ledger  ./effect-ledger    EffectLedgerJson             (도구 intent/result + lease)
//   Artifact       ./artifact         ArtifactChannelJson          (에이전트 간 산출물 공유)
//   Provider       ./index            JsonStoreProvider, createJsonStoreProvider (한 번에 전부 생성)
//
// 모든 클래스는 @dongkseo/contracts 의 *Store 인터페이스 + DescribableStore 를 구현한다.
// 백엔드 특성: name='json-file', type='dev', durable=true, multiProcess=false (개발용).
// 새 store를 export하면 여기 한 줄 추가. API 설명은 각 파일 TSDoc이 정본 — 위는 위치 안내만.

export { ConversationStoreJson } from './conversation.js';
export { TranscriptStoreJson } from './transcript.js';
export { KnowledgeStoreJson } from './knowledge.js';
export { ScheduleStoreJson } from './schedule.js';
export { ContextStoreJson } from './context-store.js';
export { AuditStoreJson } from './audit.js';
export { ToolContextStoreJson } from './tool-context.js';
export { SuspendedTurnStoreJson } from './suspended-turn.js';
export { TreeConversationStoreJson } from './session-tree.js';
export { ArtifactChannelJson } from './artifact.js';
export { WorkspaceStateStoreJson } from './workspace-state.js';
export { EffectLedgerJson } from './effect-ledger.js';

import { ConversationStoreJson } from './conversation.js';
import { TranscriptStoreJson } from './transcript.js';
import { KnowledgeStoreJson } from './knowledge.js';
import { ScheduleStoreJson } from './schedule.js';
import { ContextStoreJson } from './context-store.js';
import { AuditStoreJson } from './audit.js';
import { ToolContextStoreJson } from './tool-context.js';
import { SuspendedTurnStoreJson } from './suspended-turn.js';
import { TreeConversationStoreJson } from './session-tree.js';
import { ArtifactChannelJson } from './artifact.js';
import { WorkspaceStateStoreJson } from './workspace-state.js';
import { EffectLedgerJson } from './effect-ledger.js';

export interface JsonStoreProvider {
  conversation: ConversationStoreJson;
  transcript: TranscriptStoreJson;
  knowledge: KnowledgeStoreJson;
  schedule: ScheduleStoreJson;
  context: ContextStoreJson;
  audit: AuditStoreJson;
  toolContext: ToolContextStoreJson;
  suspendedTurn: SuspendedTurnStoreJson;
  artifact: ArtifactChannelJson;
  workspaceState: WorkspaceStateStoreJson;
  sessionTree: TreeConversationStoreJson;
  effectLedger: EffectLedgerJson;
}

/** 모든 JSON store를 한 번에 생성 */
export function createJsonStoreProvider(dataDir: string): JsonStoreProvider {
  return {
    conversation: new ConversationStoreJson(dataDir),
    transcript: new TranscriptStoreJson(dataDir),
    knowledge: new KnowledgeStoreJson(dataDir),
    schedule: new ScheduleStoreJson(dataDir),
    context: new ContextStoreJson(dataDir),
    audit: new AuditStoreJson(dataDir),
    toolContext: new ToolContextStoreJson(dataDir),
    suspendedTurn: new SuspendedTurnStoreJson(dataDir),
    artifact: new ArtifactChannelJson(dataDir),
    workspaceState: new WorkspaceStateStoreJson(dataDir),
    sessionTree: new TreeConversationStoreJson(dataDir),
    effectLedger: new EffectLedgerJson(dataDir),
  };
}
