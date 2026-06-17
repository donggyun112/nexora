/**
 * publish_topic — primitive #1 in the 4-delegation-primitives model.
 *
 * Anonymous broadcast: the caller knows a topic (or capability name) but does
 * NOT specify a target agent. Subscribers register via `card.subscribes` and
 * pick up the event on their own. There is no reply path — fire-and-forget.
 *
 * Contrast with `delegate`, which routes to a specific capability and (in
 * sync / async modes) returns a result to the caller.
 *
 * See: wiki/decisions/2026-06-01-delegation-primitives.md
 */

import type {
  ToolDefinition,
  ToolResult,
  EventTransport,
  MessageEnvelope,
  TopicString,
} from '@dongkseo/contracts';
import {
  textResult,
  errorResult,
  messageId,
  traceId,
  spanId,
  conversationId,
} from '@dongkseo/contracts';

export interface PublishTopicToolOptions {
  transport: EventTransport;
  /** Stamped onto `envelope.metadata.sourceInstanceId` for audit. */
  callerAgentName: string;
  /**
   * Optional whitelist. When set, only topics matching one of these patterns
   * may be published. Patterns follow the same wildcard rules as
   * `EventTransport.subscribe` (`*` = one segment, `#` = rest). Default: open.
   *
   * Authoring guidance: prefer a whitelist in production. The default-open
   * mode exists for the PoC where capability surface is small and trusted.
   */
  topicWhitelist?: string[];
}

interface PublishTopicParams {
  topic: string;
  payload?: unknown;
}

export function createPublishTopicTool(
  options: PublishTopicToolOptions,
): ToolDefinition {
  const { transport, callerAgentName, topicWhitelist } = options;

  return {
    name: 'publish_topic',
    description:
      'Anonymous broadcast event. Use when the work belongs to "whoever ' +
      'subscribes to this topic" — flow control via dependency inversion. ' +
      'No reply. For addressed handoff (you know which capability), use `delegate`.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description:
            'Dotted topic string (e.g. "deploy.completed", "report.generated"). ' +
            'Subscribers are matched by `card.subscribes`.',
        },
        payload: {
          description: 'Event payload. Any JSON-serializable value.',
        },
      },
      required: ['topic'],
    },
    execute: async (_callId, rawInput, ctx): Promise<ToolResult> => {
      const params = rawInput as PublishTopicParams;

      if (!params.topic || typeof params.topic !== 'string') {
        return errorResult('topic is required and must be a string');
      }

      if (topicWhitelist && topicWhitelist.length > 0) {
        const allowed = topicWhitelist.some((pattern) =>
          matchesPattern(pattern, params.topic),
        );
        if (!allowed) {
          return errorResult(
            `topic "${params.topic}" is not in the publish whitelist for ` +
              `agent "${callerAgentName}"`,
          );
        }
      }

      const envelope: MessageEnvelope = {
        id: messageId(),
        topic: params.topic,
        type: 'event',
        payload: params.payload,
        metadata: {
          traceId: traceId(),
          spanId: spanId(),
          conversationId: conversationId(),
          tenantId: ctx.tenantId,
          sourceInstanceId: callerAgentName,
          timestamp: Date.now(),
        },
      };

      ctx.logger.info('publish_topic', {
        topic: params.topic,
        caller: callerAgentName,
        envelopeId: envelope.id,
      });

      try {
        await transport.publish(envelope);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.error('publish_topic.failed', { topic: params.topic, err: msg });
        return errorResult(`publish failed: ${msg}`);
      }

      return textResult(`Published event to topic "${params.topic}"`);
    },
  };
}

/**
 * Simple wildcard match for the topic whitelist. Mirrors EventTransport's
 * pattern rules: `*` matches a single segment, `#` matches the rest.
 *
 * Kept inline to avoid a dependency cycle on the transport package's matcher.
 */
function matchesPattern(pattern: string, target: string): boolean {
  const patternParts = pattern.split('.');
  const targetParts = target.split('.');

  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    if (pp === '#') return true;
    if (i >= targetParts.length) return false;
    if (pp !== '*' && pp !== targetParts[i]) return false;
  }

  return targetParts.length === patternParts.length;
}
