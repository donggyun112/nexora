/**
 * createApprovalGate — the 4-choice human approval gate, expressed as a
 * `PreToolUse` / `OnResume` pair instead of a tool wrapper.
 *
 * Waiting for a person is not a request/reply with a deadline. The old shape
 * blocked on `transport.request(topic, …, { timeoutMs })`, holding a worker for
 * as long as the human took, and failed the call when nobody was looking —
 * while the human branch of `../builtin/handraise.ts` in this same package
 * already suspends, and `contracts/src/suspended-turn.ts` states the rule
 * outright ("the turn does not block on a timeout — it suspends"). Asking a
 * person now parks the turn; the runtime resumes it when the answer arrives.
 *
 * Decision order — the order IS the security contract:
 *
 *   preToolUse (before the executor is touched)
 *     1. hardline floor            → deny. Runs before predicate, mode and
 *        cache. No approve path, no override; `off` cannot let `rm -rf /` past.
 *     2. policy group deny/block   → deny, no prompt.
 *     3. no spec                   → continue. This call is not gated.
 *     4. resolve effective mode    (`resolveMode` → static `mode`).
 *     5. cached 'deny'             → deny, in every mode. Opting out of prompts
 *        is not the same as overruling a prior explicit deny.
 *     6. mode 'block'              → deny, no prompt.
 *     7. mode 'off'                → continue.
 *     8. cached 'allow'            → continue.
 *     9. otherwise                 → ask. Return what to ask —
 *        `suspendDecision({ topic: 'handraise.human.<channel>', payload })` —
 *        and publish nothing. The runtime mints the `pendingId`, publishes the
 *        question under it, and does so only after the park is recorded; a gate
 *        that published here would leave an orphaned question behind whenever
 *        the park failed to persist, and could not be safely re-run. The reply's
 *        `metadata.replyTo` (set by `HandraiseInbox.answer` to the question
 *        envelope id, which IS the pendingId) correlates straight back — the
 *        same correlation the handraise tool relies on. No wall-clock deadline
 *        is involved.
 *
 *   onResume (the answer came back)
 *     Steps 1-8 run AGAIN, through the very same `evaluate()`, before the
 *     answer is applied. Blocking had no TOCTOU window because the decision
 *     was applied the instant it was made; parking opens one. Policy can move
 *     while a call sits parked — a hardline rule added, a group flipped to
 *     deny, a deny cached by someone else, mode moved to 'block' — and a human
 *     'yes' from before that change must not win. Two copies of this logic
 *     would be a vulnerability the day only one of them is fixed, hence one
 *     function called from both sides.
 *     Then the choice is applied:
 *      10. 'deny'    → rememberDeny + deny
 *          'session' → rememberSession, continue
 *          'always'  → rememberAlways, continue
 *          'once'    → continue, nothing cached
 *      11. audit → `approval.granted` carries `choice` and `decidedBy`.
 *
 * A HandraiseInbox (subscribed elsewhere) collects the published request and
 * hands it to a UI (Discord buttons, etc.) which posts the ApprovalReply back
 * via `inbox.answer()`. The wire payload is unchanged — `HandraiseRequestPayload`
 * with `context: ApprovalRequest` — so existing adapters keep rendering it.
 *
 * Audit note: the gate no longer wraps the tool, so the old
 * `[approved-<choice> by <who>]` footer appended to the tool's text result is
 * gone — after `continue` the loop runs the tool and the gate never sees the
 * result. The `approval.granted` log event carries the same two facts.
 */
import type {
  EventTransport,
  OnResume,
  PreToolUse,
  ResumeAnswer,
  ToolContext,
  ToolDefinition,
  ToolGateInfo,
  ToolResult,
  TopicString,
  OutboundArtifact,
  WorkspaceSession,
} from '@dongkseo/contracts';
import {
  errorResult,
  suspendResult,
  getToolPolicyGroups,
  continueDecision,
  denyDecision,
  suspendDecision,
  suspendEnvelope,
  messageId,
} from '@dongkseo/contracts';
import type { ApprovalChoice, ApprovalRequest, ApprovalReply } from './approval.js';
import type { ApprovalPolicyStore } from './approval-store.js';
import type { HandraiseRequestPayload } from '../builtin/handraise.js';
import type { HardlineRule } from './hardline.js';

/**
 * Enforcement mode applied AFTER the hardline floor.
 *
 *   off   → bypass approval entirely (yolo / dev / cron). Cached `deny`
 *           records are still honored — opting out of prompts is not the
 *           same as overruling a prior explicit deny.
 *   ask   → default. Run cache lookup, prompt the user on `unknown`.
 *   block → short-circuit with errorResult without prompting. Useful for
 *           lockdown windows (incident, release freeze) where a class of
 *           tools must not run regardless of who is online to approve.
 *
 * The hardline floor is independent of this and fires before mode is
 * consulted — `off` cannot let `rm -rf /` through.
 */
export type ApprovalMode = 'off' | 'ask' | 'block';

export type ApprovalGatePolicyAction = 'skip' | 'ask' | 'block' | 'deny';

export interface ApprovalGateSpec {
  /** Stable key for caching (e.g., normalized command). */
  approvalKey: string;
  /** Short human-readable label shown in the prompt. */
  command: string;
  /** Why this action is being requested. */
  reason: string;
  /** Discord user IDs allowed to approve. */
  allowedUsers?: ReadonlyArray<string>;
  /** Discord role IDs allowed to approve. */
  allowedRoles?: ReadonlyArray<string>;
  /** Subset of choices to offer (default all four). */
  choices?: ReadonlyArray<ApprovalChoice>;
  /** Optional rich preview (e.g. assembled body) shown with the prompt. */
  review?: string;
  /** Optional preview artifacts (e.g. image thumbnails) shown with the prompt. */
  artifacts?: OutboundArtifact[];
}

/**
 * May be async — building a preview (e.g. resolving image thumbnails) can
 * require I/O. The gate awaits the result.
 */
export type ApprovalGatePredicate = (
  toolName: string,
  input: unknown,
) =>
  | ApprovalGateSpec
  | null
  | undefined
  | Promise<ApprovalGateSpec | null | undefined>;

export interface ApprovalGatePolicyContext {
  tool: ToolDefinition;
  toolName: string;
  input: unknown;
  policyGroup: string;
  policyGroups: readonly string[];
  channel: string;
  tenantId: string;
  sessionKey: string;
  /** Active workspace boundary for the tool call, when the tool has one. */
  workspace?: WorkspaceSession;
}

export type ApprovalGatePolicyDecision =
  | ApprovalGatePolicyAction
  | ({
      action: ApprovalGatePolicyAction;
    } & Partial<ApprovalGateSpec>);

export type ApprovalGatePolicyResolver = (
  ctx: ApprovalGatePolicyContext,
) =>
  | ApprovalGatePolicyDecision
  | null
  | undefined
  | Promise<ApprovalGatePolicyDecision | null | undefined>;

export interface ApprovalGateOptions {
  /** Policy store for session/always caching. */
  store: ApprovalPolicyStore;
  /**
   * Decides whether a given tool call needs approval and supplies the
   * approvalKey + display info. Return null/undefined to bypass the gate.
   * Used as fallback after policy-group resolution. Optional for callers that
   * express all approval policy with ToolDefinition.policyGroups.
   */
  predicate?: ApprovalGatePredicate;
  /**
   * First-class policy-group resolver. For every group declared on
   * ToolDefinition.policyGroups/permissionGroups, return:
   *   - 'skip'  → this group does not require gate handling in this channel
   *   - 'ask'   → build an ApprovalGateSpec and prompt through normal flow
   *   - 'block' → short-circuit without prompting
   *   - 'deny'  → hard policy denial without prompting
   *
   * If multiple groups match, deny/block wins over ask; otherwise the first ask
   * spec is used. Undefined/null is treated like 'skip'.
   *
   * Requires `resolveTool` — groups live on the ToolDefinition and a gate stage
   * is handed only `{callId, name, input}`.
   */
  resolveGroupAction?: ApprovalGatePolicyResolver;
  /**
   * Looks up the ToolDefinition behind a call name. Needed only by
   * `resolveGroupAction`: `policyGroups` / `permissionGroups` are declared on
   * the definition, and a `PreToolUse` stage receives the call, not the tool.
   *
   * Fail-closed: when `resolveGroupAction` is configured and the name does not
   * resolve, the call is denied rather than passed on unchecked — "no tool
   * found" must not read as "declares no groups", or an escalation guard is
   * bypassed by a lookup miss.
   */
  resolveTool?: (toolName: string) => ToolDefinition | undefined;
  /**
   * Channel suffix for the handraise topic. The question is asked on
   * `handraise.human.<channel>`. Default: 'default'.
   */
  channel?: string;
  /**
   * Resolver for the sessionKey at request time. Falls back to a stable
   * synthetic key when not provided (single shared session per tenant —
   * usable for tests but not recommended for production).
   */
  resolveSessionKey?: (ctx: { tenantId: string; toolName: string }) => string;
  /**
   * Resolver for the outbound routing (channel/thread to post the prompt
   * in). When omitted, the bridge falls back to parsing the sessionKey.
   * Production deployments should plumb this through from the inbound
   * adapter so the prompt lands in the exact conversation that triggered
   * the tool call.
   */
  resolveRoute?: (ctx: {
    tenantId: string;
    toolName: string;
    sessionKey: string;
  }) => { channelId?: string; threadId?: string } | null | undefined;
  /**
   * Static enforcement mode. Defaults to 'ask'. Overridden per-call by
   * `resolveMode` when provided — use that for tenant-policy lookups.
   */
  mode?: ApprovalMode;
  /**
   * Per-call mode resolver (e.g. tenant policy → 'block' during a release
   * freeze, 'off' for trusted internal services). Takes precedence over
   * the static `mode` field. Return undefined to fall back to it.
   */
  resolveMode?: (ctx: {
    tenantId: string;
    toolName: string;
    sessionKey: string;
  }) => ApprovalMode | undefined | Promise<ApprovalMode | undefined>;
  /**
   * Hardline floor — unconditional block applied BEFORE mode is consulted.
   * Fires for catastrophic actions (`rm -rf /`, `mkfs`, fork bomb…) that
   * have no legitimate approve path. mode='off' does NOT bypass this.
   * Defaults to no hardline checks; pass `defaultShellHardlineRule` for
   * shell-style tools.
   */
  hardline?: HardlineRule;
}

/**
 * What steps 1-8 concluded. `ask` is the only outcome that still needs a human,
 * and it carries what step 9 (publish) and step 10 (apply the answer) need.
 */
type GateVerdict =
  | { kind: 'deny'; result: ToolResult }
  | { kind: 'allow' }
  | { kind: 'ask'; spec: ApprovalGateSpec; tenantId: string; sessionKey: string };

export function createApprovalGate(options: ApprovalGateOptions): {
  preToolUse: PreToolUse;
  onResume: OnResume;
} {
  const {
    store,
    predicate = () => null,
    resolveGroupAction,
    resolveTool,
    channel = 'default',
    resolveSessionKey,
    resolveRoute,
    mode: staticMode = 'ask',
    resolveMode,
    hardline,
  } = options;
  const topic = `handraise.human.${channel}` as TopicString;

  return { preToolUse, onResume };

  async function preToolUse(info: ToolGateInfo) {
    const verdict = await evaluate(info, 'pre_tool_use');
    if (verdict.kind === 'deny') return denyDecision(verdict.result);
    if (verdict.kind === 'allow') return continueDecision();

    const { spec, tenantId, sessionKey } = verdict;
    const toolName = info.call.name;
    const route = resolveRoute?.({ tenantId, toolName, sessionKey });
    const request: ApprovalRequest = {
      kind: 'approval',
      approvalKey: spec.approvalKey,
      command: spec.command,
      reason: spec.reason,
      sessionKey,
      allowedUsers: spec.allowedUsers,
      allowedRoles: spec.allowedRoles,
      choices: spec.choices,
      ...(route?.channelId ? { channelId: route.channelId } : {}),
      ...(route?.threadId ? { threadId: route.threadId } : {}),
      ...(spec.review ? { review: spec.review } : {}),
      ...(spec.artifacts && spec.artifacts.length > 0 ? { artifacts: spec.artifacts } : {}),
    };

    info.context?.logger.info('approval.request', {
      tool: toolName,
      approvalKey: spec.approvalKey,
    });

    // Just what to ask. The runtime mints the pendingId, sets it as the question
    // envelope's id (which is what the reply's metadata.replyTo correlates
    // against) and publishes — after it has recorded the park. Deciding here and
    // publishing there is what makes this stage safe to re-run.
    return suspendDecision({
      topic,
      payload: {
        question: `Approve: ${spec.command}`,
        context: request,
        callId: info.call.callId,
      } satisfies HandraiseRequestPayload,
    });
  }

  async function onResume(info: ToolGateInfo & { readonly resume: ResumeAnswer }) {
    // Revalidate under CURRENT policy before the answer counts — see the
    // module docstring on the window parking opens.
    const verdict = await evaluate(info, 'on_resume');
    if (verdict.kind === 'deny') return denyDecision(verdict.result);
    // Policy now clears the call without asking (mode went 'off', a cached
    // allow landed, the spec is gone): the parked question is moot.
    if (verdict.kind === 'allow') return continueDecision();

    const { spec, tenantId, sessionKey } = verdict;
    const toolName = info.call.name;
    const reply = info.resume.answer as ApprovalReply | undefined;
    const choice = reply?.choice;
    if (!choice) return denyDecision(errorResult('Approval reply was missing a choice'));

    const decidedBy = reply?.displayName ?? reply?.userId;

    if (choice === 'deny') {
      await store.rememberDeny(tenantId, sessionKey, spec.approvalKey, decidedBy);
      return denyDecision(
        errorResult(`Approval denied${decidedBy ? ` by ${decidedBy}` : ''}: ${toolName}`),
      );
    }
    if (choice === 'session') {
      await store.rememberSession(
        tenantId,
        sessionKey,
        spec.approvalKey,
        'session',
        decidedBy,
      );
    } else if (choice === 'always') {
      await store.rememberAlways(tenantId, spec.approvalKey, decidedBy);
    }
    // 'once' → proceed without caching

    // The tool result is out of reach from here, so this log is the audit
    // trail: choice + who decided.
    info.context?.logger.info('approval.granted', {
      tool: toolName,
      choice,
      decidedBy,
    });
    return continueDecision();
  }

  /**
   * Steps 1-8, shared by `preToolUse` and `onResume`. One copy on purpose: a
   * second copy is a vulnerability as soon as only one of them is fixed.
   *
   * `source` rides along into every log line because the same verdict means two
   * different things depending on where it came from: at `pre_tool_use` a deny
   * is a call that never ran, at `on_resume` it is a human's `yes` overturned by
   * policy that moved while the call sat parked. An operator reading
   * `approval.cached.deny` cannot tell those apart otherwise, and the second one
   * is the one worth paging about.
   */
  async function evaluate(
    info: ToolGateInfo,
    source: 'pre_tool_use' | 'on_resume',
  ): Promise<GateVerdict> {
    const toolName = info.call.name;
    const input = info.call.input;

    // 1. Hardline floor — before predicate, mode, and cache. No approval, no
    // override. See hardline.ts for the rationale.
    if (hardline) {
      const hit = hardline(toolName, input);
      if (hit) {
        info.context?.logger.warn('approval.hardline.block', {
          tool: toolName,
          source,
          ruleId: hit.ruleId,
          description: hit.description,
        });
        return {
          kind: 'deny',
          result: errorResult(
            `BLOCKED by hardline floor (${hit.ruleId}): ${hit.description}. ` +
              `This action has no approve path — do not retry, do not ` +
              `rephrase, do not attempt the same outcome via a different tool.`,
          ),
        };
      }
    }

    // Everything below is keyed by tenant — the cache, the session scope, the
    // policy lookups. `ToolGateInfo.context` is optional because
    // `ToolExecutor.getContext` is, so fail closed instead of guessing a tenant
    // and reading another tenant's approvals.
    const context = info.context;
    if (!context) {
      return {
        kind: 'deny',
        result: errorResult(
          `DENIED: approval gate has no tool context for ${toolName}, so the ` +
            `tenant cannot be established. Wire ToolExecutor.getContext().`,
        ),
      };
    }
    const tenantId = context.tenantId;
    const sessionKey =
      resolveSessionKey?.({ tenantId, toolName }) ?? `tenant:${tenantId}`;

    // 2. Policy group gate.
    const groupGate = await resolvePolicyGroupGate(
      toolName,
      input,
      tenantId,
      sessionKey,
      context,
    );
    if (groupGate?.kind === 'deny' || groupGate?.kind === 'block') {
      context.logger.info(`approval.policy_group.${groupGate.kind}`, {
        tool: toolName,
        source,
        policyGroup: groupGate.policyGroup,
      });
      return { kind: 'deny', result: errorResult(groupGate.message) };
    }

    // 3. No spec → not gated.
    const spec =
      groupGate?.kind === 'ask' ? groupGate.spec : await predicate(toolName, input);
    if (!spec) return { kind: 'allow' };

    // 4. Effective mode.
    const effectiveMode: ApprovalMode =
      (await resolveMode?.({ tenantId, toolName, sessionKey })) ?? staticMode;

    // 5. Cached deny is binding regardless of mode — an explicit prior
    // deny is not something `off` should override silently.
    const cached = await store.lookup(tenantId, sessionKey, spec.approvalKey);
    if (cached === 'deny') {
      context.logger.info('approval.cached.deny', {
        tool: toolName,
        source,
        approvalKey: spec.approvalKey,
      });
      return {
        kind: 'deny',
        result: errorResult(`Approval denied by prior policy for ${toolName}`),
      };
    }

    // 6. mode 'block' → no prompt.
    if (effectiveMode === 'block') {
      context.logger.info('approval.mode.block', {
        tool: toolName,
        source,
        approvalKey: spec.approvalKey,
      });
      return {
        kind: 'deny',
        result: errorResult(
          `BLOCKED by approval mode='block': ${toolName} is currently ` +
            `disallowed by policy. No prompt was issued.`,
        ),
      };
    }

    // 7. mode 'off'.
    if (effectiveMode === 'off') {
      context.logger.info('approval.mode.off', {
        tool: toolName,
        source,
        approvalKey: spec.approvalKey,
      });
      return { kind: 'allow' };
    }

    // 8. Cached allow.
    if (cached === 'allow') {
      context.logger.info('approval.cached.allow', {
        tool: toolName,
        source,
        approvalKey: spec.approvalKey,
      });
      return { kind: 'allow' };
    }

    // 9. Ask a human.
    return { kind: 'ask', spec, tenantId, sessionKey };
  }

  async function resolvePolicyGroupGate(
    toolName: string,
    input: unknown,
    tenantId: string,
    sessionKey: string,
    context: ToolContext,
  ): Promise<
    | { kind: 'ask'; policyGroup: string; spec: ApprovalGateSpec }
    | { kind: 'block' | 'deny'; policyGroup: string; message: string }
    | null
  > {
    if (!resolveGroupAction) return null;
    const tool = resolveTool?.(toolName);
    if (!tool) {
      return {
        kind: 'deny',
        policyGroup: '<unresolved>',
        message:
          `DENIED: approval gate could not resolve tool '${toolName}' to read its ` +
          `policy groups, so group policy cannot be enforced. No prompt was issued.`,
      };
    }
    const policyGroups = getToolPolicyGroups(tool);
    let ask: { kind: 'ask'; policyGroup: string; spec: ApprovalGateSpec } | null = null;

    for (const policyGroup of policyGroups) {
      const raw = await resolveGroupAction({
        tool,
        toolName,
        input,
        policyGroup,
        policyGroups,
        channel,
        tenantId,
        sessionKey,
        workspace: context.workspace,
      });
      const decision = normalizePolicyDecision(raw);
      if (!decision || decision.action === 'skip') continue;

      if (decision.action === 'deny' || decision.action === 'block') {
        const label = decision.action === 'deny' ? 'DENIED' : 'BLOCKED';
        const reason = decision.reason ?? `policy group '${policyGroup}'`;
        return {
          kind: decision.action,
          policyGroup,
          message: `${label} by policy group '${policyGroup}': ${reason}. No prompt was issued.`,
        };
      }

      if (!ask) {
        ask = {
          kind: 'ask',
          policyGroup,
          spec: {
            approvalKey: decision.approvalKey ?? `${toolName}:${policyGroup}`,
            command: decision.command ?? toolName,
            reason: decision.reason ?? `Policy group '${policyGroup}' requires approval.`,
            ...(decision.allowedUsers ? { allowedUsers: decision.allowedUsers } : {}),
            ...(decision.allowedRoles ? { allowedRoles: decision.allowedRoles } : {}),
            ...(decision.choices ? { choices: decision.choices } : {}),
            ...(decision.review ? { review: decision.review } : {}),
            ...(decision.artifacts ? { artifacts: decision.artifacts } : {}),
          },
        };
      }
    }

    return ask;
  }
}

/**
 * Apply a `PreToolUse` decision to a single ToolDefinition.
 *
 * For callers that hold one tool rather than a loop — `createDelegateTool`'s
 * `approvalGate` option, small demos. `deny` becomes the tool's result and
 * `suspend` becomes `suspendResult(pendingId)`, which parks the turn exactly
 * like the handraise tool does. The `onResume` half cannot live here: once the
 * answer arrives the runtime, not the tool, decides what to do with it.
 *
 * This is the tool path, so publishing happens here: a tool that returns
 * `suspendResult` has already asked its question by the time the runtime sees
 * it, same as the human branch of the handraise tool. That needs a `transport`;
 * without one a suspending decision has no way out and is reported as an error
 * rather than silently parking a turn nobody was asked about.
 */
export function gateTool(
  tool: ToolDefinition,
  preToolUse: PreToolUse,
  transport?: EventTransport,
): ToolDefinition {
  const original = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (callId, input, ctx): Promise<ToolResult> => {
      const decision = await preToolUse({
        call: { callId, name: tool.name, input },
        context: ctx,
      });
      if (decision.kind === 'deny') return decision.result;
      if (decision.kind === 'suspend') {
        if (!transport) {
          return errorResult(
            `Approval for ${tool.name} needs a human, but gateTool was wired without a ` +
              `transport to ask on. Pass one, or gate through RuntimeServices.preToolUse.`,
          );
        }
        const pendingId = messageId();
        await transport.publish(suspendEnvelope(pendingId, decision.request, ctx.tenantId));
        return suspendResult(pendingId);
      }
      return original(callId, input, ctx);
    },
  };
}

function normalizePolicyDecision(
  decision: ApprovalGatePolicyDecision | null | undefined,
): ({ action: ApprovalGatePolicyAction } & Partial<ApprovalGateSpec>) | null {
  if (!decision) return null;
  if (typeof decision === 'string') return { action: decision };
  return decision;
}
