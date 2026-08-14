/**
 * @dongkseo/tools/handraise — human-in-the-loop primitive.
 */

export { HandraisePolicy, approveMatching, denyMatching } from './policy.js';
export type {
  HandraiseContext,
  HandraiseRule,
  HandraiseRuleMatch,
  HandraisePolicyResult,
} from './policy.js';

export { HandraiseInbox } from './inbox.js';
export type {
  HandraiseInboxOptions,
  PendingHandraise,
} from './inbox.js';

export { isApprovalRequest } from './approval.js';
export type {
  ApprovalChoice,
  ApprovalRequest,
  ApprovalReply,
} from './approval.js';

export { InMemoryApprovalPolicyStore } from './approval-store.js';
export type {
  ApprovalPolicyStore,
  ApprovalDecision,
  ApprovalRecord,
} from './approval-store.js';

export { createApprovalGate, gateTool } from './approval-middleware.js';
export type {
  ApprovalGateOptions,
  ApprovalGateSpec,
  ApprovalGatePredicate,
  ApprovalGatePolicyAction,
  ApprovalGatePolicyContext,
  ApprovalGatePolicyDecision,
  ApprovalGatePolicyResolver,
  ApprovalMode,
} from './approval-middleware.js';

export { decide, mergeRules, createGroupPolicyResolver } from './approval-policy.js';
export type { PolicyRules } from './approval-policy.js';

export { attenuate, createEscalationGuard } from './authority.js';

export {
  defaultShellHardlineRule,
  composeHardlineRules,
  extractCommandString,
} from './hardline.js';
export type { HardlineRule, HardlineHit } from './hardline.js';
