/**
 * handraise — pause and ask for input.
 *
 * This is the framework primitive for an agent to say "I am uncertain,
 * stop and get me an answer before I proceed". It is the missing fourth
 * agent state (alongside running / done / error): SUSPENDED-AWAITING-INPUT.
 *
 * Why it matters:
 *   - Without it, an agent that doesn't know something either hallucinates
 *     or gives up. Handraise turns "I don't know" into a first-class,
 *     observable request that a human, another agent, or a policy engine
 *     can answer.
 *   - It is the cleanest place to put human-in-the-loop approvals for
 *     destructive or high-risk actions.
 *   - It enables long-running conversations that require external
 *     adjudication (finance approvals, compliance reviews, creative judgment).
 *
 * The request/reply plumbing reuses the existing `Transport.request()`
 * primitive — handraise publishes to a well-known topic and blocks on a
 * matching reply. That keeps the implementation tiny (~100 LOC) and means
 * any transport that supports request/reply (Local, Redis, RedisStreams)
 * automatically supports handraise.
 *
 * Three recipient strategies:
 *   - { type: 'topic', topic: 'handraise.billing' }
 *       Publish to the exact topic. Any subscriber may answer.
 *   - { type: 'capability', capability: 'billing.approval' }
 *       Look up an agent with that capability in the registry, use its first
 *       subscribed topic as the handraise target. Enables dynamic routing
 *       without the calling agent knowing who will answer.
 *   - { type: 'human', channel: 'compliance' }
 *       Publish to `handraise.human.<channel>` (default 'default'). A
 *       HandraiseInbox (see ./handraise-inbox.ts) or UI subscribes and
 *       presents the question to a human operator.
 *
 * Policy pre-flight (optional):
 *   If a HandraisePolicy is configured, the tool runs it BEFORE the
 *   transport round-trip. Matching policies auto-answer and the agent
 *   never sees the delay. Rules that fall through escalate to the
 *   configured recipient as usual. This lets operators automate the
 *   "safe" cases while reserving humans for the hard ones.
 */

import type {
  ToolDefinition,
  ToolResult,
  EventTransport,
  AgentRegistry,
  TopicString,
  MessageEnvelope,
} from '@dongkseo/contracts';
import { textResult, errorResult } from '@dongkseo/contracts';
import type { HandraisePolicy } from '../handraise/policy.js';

export type HandraiseRecipient =
  | { type: 'topic'; topic: string }
  | { type: 'capability'; capability: string }
  | { type: 'human'; channel?: string };

export interface HandraiseToolOptions {
  /** Transport used for the request/reply round-trip. */
  transport: EventTransport;
  /** Optional registry for `capability` recipient resolution. */
  registry?: AgentRegistry;
  /**
   * Optional auto-answer policy. If provided, runs BEFORE the transport
   * request — matching rules short-circuit the round-trip.
   */
  policy?: HandraisePolicy;
  /** Default timeout if the caller doesn't specify one. Default: 300_000 (5 min). */
  defaultTimeoutMs?: number;
}

interface HandraiseParams {
  question: string;
  recipient: HandraiseRecipient;
  /** Optional JSON Schema that the answer must satisfy. Informational only at this layer. */
  answerSchema?: Record<string, unknown>;
  /** Extra structured context sent with the question. */
  context?: unknown;
  /** Override the default timeout. */
  timeoutMs?: number;
}

export interface HandraiseRequestPayload {
  question: string;
  context?: unknown;
  answerSchema?: Record<string, unknown>;
  /** Tool call id — echoed back in the reply so the caller can correlate. */
  callId: string;
}

export interface HandraiseReplyPayload {
  /** Whatever the responder chose to send back. */
  answer: unknown;
  /** Optional free-text reasoning the responder provided. */
  rationale?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function createHandraiseTool(options: HandraiseToolOptions): ToolDefinition {
  const { transport, registry, policy, defaultTimeoutMs = DEFAULT_TIMEOUT_MS } = options;

  return {
    name: 'handraise',
    description:
      'Pause execution and request an answer from a human, another agent, or a policy engine. ' +
      'Use when you are genuinely uncertain, need approval for a destructive or high-risk action, ' +
      'or require information you cannot obtain through your other tools. The answer is returned ' +
      'as a string so you can parse it yourself; include an answerSchema in the call if you want ' +
      'to constrain the shape.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'Plain-language question. Be specific and mention what you will do with each possible answer.',
        },
        recipient: {
          type: 'object',
          description:
            'Who should answer. One of: ' +
            '{ type: "topic", topic: "..." } | ' +
            '{ type: "capability", capability: "..." } | ' +
            '{ type: "human", channel?: "..." }',
        },
        answerSchema: {
          type: 'object',
          description: 'Optional JSON Schema the answer should satisfy (for downstream validation).',
        },
        context: {
          type: 'object',
          description: 'Structured context attached to the question (related entities, pending action, etc.).',
        },
        timeoutMs: {
          type: 'number',
          description: `Maximum time to wait for an answer in milliseconds. Default ${defaultTimeoutMs}.`,
        },
      },
      required: ['question', 'recipient'],
    },
    execute: async (callId, input, ctx): Promise<ToolResult> => {
      const params = input as HandraiseParams;

      if (!params.question || typeof params.question !== 'string') {
        return errorResult('question is required');
      }
      if (!params.recipient || typeof params.recipient !== 'object') {
        return errorResult('recipient is required');
      }

      const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0
        ? params.timeoutMs
        : defaultTimeoutMs;

      // Policy pre-flight — if any rule matches, return its answer immediately.
      if (policy) {
        const autoAnswer = await policy.evaluate({
          question: params.question,
          context: params.context,
          recipient: params.recipient,
          tenantId: ctx.tenantId,
        });
        if (autoAnswer.matched) {
          ctx.logger.info('handraise auto-answered by policy', {
            question: params.question.slice(0, 80),
            rule: autoAnswer.rule,
          });
          return textResult(formatAnswer(autoAnswer.answer, autoAnswer.rationale));
        }
      }

      // Resolve the topic from the recipient strategy.
      let topic: string;
      try {
        topic = await resolveRecipient(params.recipient, registry);
      } catch (err) {
        return errorResult(`handraise recipient: ${err instanceof Error ? err.message : String(err)}`);
      }

      const requestPayload: HandraiseRequestPayload = {
        question: params.question,
        context: params.context,
        answerSchema: params.answerSchema,
        callId,
      };

      ctx.logger.info('handraise', {
        topic,
        question: params.question.slice(0, 80),
        timeoutMs,
      });

      let reply: MessageEnvelope;
      try {
        reply = await transport.request(topic as TopicString, requestPayload, {
          timeoutMs,
          tenantId: ctx.tenantId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // The common case is a timeout, which is actionable (the agent can
        // decide what to do). We return a text result, not an error result,
        // so the agent's reasoning loop can see and handle it.
        return textResult(`[handraise no-answer] ${msg}`);
      }

      const answerPayload = reply.payload as HandraiseReplyPayload | undefined;
      if (!answerPayload || !('answer' in (answerPayload as object))) {
        return errorResult(`handraise received malformed reply (missing 'answer' field)`);
      }

      return textResult(formatAnswer(answerPayload.answer, answerPayload.rationale));
    },
  };
}

async function resolveRecipient(
  recipient: HandraiseRecipient,
  registry: AgentRegistry | undefined,
): Promise<string> {
  if (recipient.type === 'topic') {
    if (!recipient.topic) throw new Error('recipient.topic is required for type "topic"');
    return recipient.topic;
  }

  if (recipient.type === 'human') {
    const channel = recipient.channel ?? 'default';
    return `handraise.human.${channel}`;
  }

  if (recipient.type === 'capability') {
    if (!registry) {
      throw new Error('capability recipient requires a registry to be passed to createHandraiseTool');
    }
    const candidates = await registry.findByCapability(recipient.capability);
    if (candidates.length === 0) {
      throw new Error(`no agent declares capability "${recipient.capability}"`);
    }
    const target = candidates[0];
    const targetTopic = target.subscribes[0];
    if (!targetTopic) {
      throw new Error(`agent "${target.name}" declares capability "${recipient.capability}" but has no subscribes topics`);
    }
    return String(targetTopic);
  }

  // @ts-expect-error — exhaustiveness check
  throw new Error(`unknown recipient type: ${recipient?.type}`);
}

function formatAnswer(answer: unknown, rationale?: string): string {
  const body = typeof answer === 'string' ? answer : JSON.stringify(answer);
  return rationale ? `${body}\n\n[rationale] ${rationale}` : body;
}
