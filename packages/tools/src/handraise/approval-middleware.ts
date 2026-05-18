/**
 * approvalGateMiddleware — wraps risky tools with a 4-choice approval gate.
 *
 * Caller supplies a predicate `(toolName, input) => ApprovalSpec | null`. For
 * each tool call where the predicate returns a spec, the middleware:
 *
 *   1. Looks up (tenantId, sessionKey, approvalKey) in the policy store.
 *      - 'allow' → run the underlying tool immediately.
 *      - 'deny'  → short-circuit with an errorResult.
 *      - 'unknown' → fall through to step 2.
 *   2. Publishes an ApprovalRequest via transport.request to
 *      `handraise.human.<channel>`. Blocks until a reply or timeout.
 *      A HandraiseInbox (subscribed elsewhere) collects the request and
 *      hands it to a UI (Discord buttons, etc.) which posts back via
 *      `inbox.answer()`.
 *   3. Applies the returned ApprovalChoice:
 *      - 'once'    → proceed, no cache.
 *      - 'session' → cache for sessionKey, proceed.
 *      - 'always'  → cache permanently for tenant, proceed.
 *      - 'deny'    → errorResult.
 *
 * The handraise tool itself stays unchanged — this middleware uses the same
 * topic / transport plumbing but with a typed approval payload.
 */
import type {
  EventTransport,
  ToolDefinition,
  ToolResult,
  TopicString,
  MessageEnvelope,
} from '@nexora/contracts';
import { textResult, errorResult } from '@nexora/contracts';
import type { ApprovalChoice, ApprovalRequest, ApprovalReply } from './approval.js';
import type { ApprovalPolicyStore } from './approval-store.js';
import type {
  HandraiseRequestPayload,
  HandraiseReplyPayload,
} from '../builtin/handraise.js';

/**
 * Structural subset of `@nexora/core`'s AgentMiddleware. Defined locally to
 * avoid a `tools → core` package dependency (core already depends on tools
 * transitively via team.ts). The full middleware shape is structurally
 * compatible — callers can pass this to MiddlewarePipeline directly.
 */
interface MiddlewareShape {
  name: string;
  beforeExecution(ctx: {
    tools: ToolDefinition[];
    [key: string]: unknown;
  }): void;
}

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
}

export type ApprovalGatePredicate = (
  toolName: string,
  input: unknown,
) => ApprovalGateSpec | null | undefined;

export interface ApprovalGateOptions {
  /** Transport used for the approval round-trip. */
  transport: EventTransport;
  /** Policy store for session/always caching. */
  store: ApprovalPolicyStore;
  /**
   * Decides whether a given tool call needs approval and supplies the
   * approvalKey + display info. Return null/undefined to bypass the gate.
   */
  predicate: ApprovalGatePredicate;
  /**
   * Channel suffix for the handraise topic. The middleware publishes to
   * `handraise.human.<channel>`. Default: 'default'.
   */
  channel?: string;
  /** Wait time before declaring the approval expired. Default 5 min. */
  timeoutMs?: number;
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
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function createApprovalGateMiddleware(
  options: ApprovalGateOptions,
): MiddlewareShape {
  const {
    transport,
    store,
    predicate,
    channel = 'default',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    resolveSessionKey,
    resolveRoute,
  } = options;
  const topic = `handraise.human.${channel}` as TopicString;

  return {
    name: 'approval-gate',
    beforeExecution(ctx) {
      ctx.tools = ctx.tools.map((tool) => wrapTool(tool));
    },
  };

  function wrapTool(tool: ToolDefinition): ToolDefinition {
    const original = tool.execute.bind(tool);
    return {
      ...tool,
      execute: async (callId, input, toolCtx): Promise<ToolResult> => {
        const spec = predicate(tool.name, input);
        if (!spec) return original(callId, input, toolCtx);

        const tenantId = toolCtx.tenantId;
        const sessionKey =
          resolveSessionKey?.({ tenantId, toolName: tool.name }) ??
          `tenant:${tenantId}`;

        const cached = await store.lookup(tenantId, sessionKey, spec.approvalKey);
        if (cached === 'allow') {
          toolCtx.logger.info('approval.cached.allow', {
            tool: tool.name,
            approvalKey: spec.approvalKey,
          });
          return original(callId, input, toolCtx);
        }
        if (cached === 'deny') {
          toolCtx.logger.info('approval.cached.deny', {
            tool: tool.name,
            approvalKey: spec.approvalKey,
          });
          return errorResult(`Approval denied by prior policy for ${tool.name}`);
        }

        const route = resolveRoute?.({
          tenantId,
          toolName: tool.name,
          sessionKey,
        });
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
        };

        toolCtx.logger.info('approval.request', {
          tool: tool.name,
          approvalKey: spec.approvalKey,
        });

        const wrapped: HandraiseRequestPayload = {
          question: `Approve: ${spec.command}`,
          context: request,
          callId,
        };

        let reply: MessageEnvelope;
        try {
          reply = await transport.request(topic, wrapped, {
            timeoutMs,
            tenantId,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return errorResult(`Approval timed out or failed: ${msg}`);
        }

        const replyPayload = reply.payload as HandraiseReplyPayload | undefined;
        const approvalReply = replyPayload?.answer as ApprovalReply | undefined;
        const choice = approvalReply?.choice;
        if (!choice) return errorResult('Approval reply was missing a choice');

        const decidedBy = approvalReply?.displayName ?? approvalReply?.userId;

        if (choice === 'deny') {
          await store.rememberDeny(tenantId, sessionKey, spec.approvalKey, decidedBy);
          return errorResult(
            `Approval denied${decidedBy ? ` by ${decidedBy}` : ''}: ${tool.name}`,
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

        toolCtx.logger.info('approval.granted', {
          tool: tool.name,
          choice,
          decidedBy,
        });
        const result = await original(callId, input, toolCtx);
        // Annotate text result with audit footer for visibility in transcripts.
        if (result.type === 'text' && decidedBy) {
          return textResult(`${result.text}\n\n[approved-${choice} by ${decidedBy}]`);
        }
        return result;
      },
    };
  }
}
