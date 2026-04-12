/**
 * Agent Bootstrap — 에이전트 부팅.
 *
 * 책임:
 *   1. AgentCard에 선언된 topic 구독
 *   2. 메시지 수신 시 ContextLoader로 컨텍스트 빌드
 *   3. AgentRunner.execute() 실행
 *   4. 결과를 result topic으로 발행 (replyTo 설정)
 *   5. shutdown 시 구독 해제
 *
 * 한 패키지에서 transport/context를 직접 의존하지 않도록
 * 인터페이스로만 받는다.
 */

import type {
  AgentCard,
  AgentContext,
  AgentRegistry,
  AgentRuntime,
  AgentInput,
  AgentEvent,
  ContextLoader,
  EventTransport,
  Subscription,
  MessageEnvelope,
  AgentLogger,
  TopicString,
} from '@nexora/contracts';
import { messageId, spanId, matchTopic } from '@nexora/contracts';
import { createSchemaValidator, SchemaValidationError } from './schema.js';
import { enforceLint } from './lint.js';

export interface AgentBootstrapOptions {
  /** Agent capability declaration (subscribes / publishes / tools / architecture). */
  card: AgentCard;
  /** Loads per-tenant context (system prompt, limits, tool allowlist) for each request. */
  contextLoader: ContextLoader;
  /** Transport the agent uses to send and receive messages. */
  transport: EventTransport;
  /**
   * Optional registry. If provided, `bootstrapAgent` will automatically call
   * `registry.register(card)` at startup and `registry.unregister(card.name)`
   * at shutdown. Lets other components (workflow engine, gateway routing) look
   * up the card without the caller having to thread the registry through manually.
   */
  registry?: AgentRegistry;
  /**
   * Per-request AgentRuntime factory. Receives the full tenant-resolved
   * context so it can build a ToolContext from `context.runtime.workdir`,
   * apply `context.limits` to the runner, and filter tools against
   * `context.tools`.
   */
  createRuntime: (args: {
    context: AgentContext;
    envelope: MessageEnvelope;
  }) => AgentRuntime | Promise<AgentRuntime>;
  /**
   * Convert an incoming MessageEnvelope into the agent's domain-specific
   * AgentInput. Each agent implements this per its payload schema.
   */
  toAgentInput: (envelope: MessageEnvelope) => AgentInput;
  /**
   * Compute the topic to publish the result on. Default: first entry of
   * `card.publishes`, or `<incoming-topic>.completed` if `publishes` is empty.
   *
   * The chosen topic is lint-checked against `card.publishes` at runtime —
   * a mismatch is logged as a warning (not an error, because many operators
   * use dynamic routing that can't be declared statically). Set
   * `strictPublishLint: true` to turn the warning into a hard error.
   */
  resultTopicFor?: (envelope: MessageEnvelope) => string;
  /**
   * Convert the agent's AgentEvent stream into a serializable result payload.
   * Default: `{ content, toolCalls }` for done events, `{ error }` for errors.
   */
  buildResultPayload?: (events: AgentEvent[]) => unknown;
  /**
   * If true, publishing a result topic that doesn't match any `card.publishes`
   * pattern throws instead of logging a warning. Default: false.
   */
  strictPublishLint?: boolean;
  /**
   * If set, this agent instance only processes messages whose
   * `envelope.metadata.tenantId` matches. Messages for other tenants are
   * silently dropped. This is a CORRECTNESS guard, not a security boundary —
   * a malicious sibling that forgets to set `tenantId` will still see all
   * traffic. For true isolation, run one bootstrap per tenant and use a
   * transport that can route per-tenant (or a per-tenant channel prefix).
   */
  tenantId?: string;
  /**
   * If true, incoming messages are validated against `card.inputSchema` and
   * outgoing results against `card.outputSchema` (JSON Schema, AJV-backed).
   * Validation failures are routed to `<topic>.schema-rejected` (for input)
   * or `<topic>.failed` (for output). Default: true when either schema is
   * present on the card; no-op when both are undefined.
   */
  validateSchemas?: boolean;
  /** Logger for framework-level events (boot, shutdown, lint warnings). */
  logger?: AgentLogger;
}

export interface RunningAgent {
  card: AgentCard;
  shutdown(): Promise<void>;
}

const NOOP_LOGGER: AgentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/**
 * Bootstrap an agent: auto-register to the registry (if provided), subscribe
 * to every topic in `card.subscribes`, and run each incoming message through
 * the `createRuntime` factory → `AgentRunner` → topic publish result pipeline.
 */
export async function bootstrapAgent(options: AgentBootstrapOptions): Promise<RunningAgent> {
  const {
    card,
    contextLoader,
    transport,
    registry,
    createRuntime,
    toAgentInput,
    resultTopicFor,
    buildResultPayload,
    strictPublishLint = false,
    tenantId: scopedTenantId,
  } = options;
  const logger = options.logger ?? NOOP_LOGGER;

  // #6 PHILOSOPHY AS CONSTRAINTS: lint the AgentCard on every bootstrap.
  // This catches misconfigured agents (bad topic names, missing schemas,
  // invalid agent names) at startup instead of at 2 AM during an incident.
  enforceLint(card, logger);

  // Build schema validators once at boot. No-op if the card declares no schemas.
  const validateSchemas = options.validateSchemas ?? (
    card.inputSchema !== undefined || card.outputSchema !== undefined
  );
  const { validateInput, validateOutput } = validateSchemas
    ? createSchemaValidator(card)
    : { validateInput: () => {}, validateOutput: () => {} };

  // Auto-register to the registry before taking any traffic. If the registry
  // is a remote service and the call fails, we fail the whole bootstrap —
  // we don't want an unregistered agent silently pulling messages.
  if (registry) {
    await registry.register(card);
    logger.info(`Agent ${card.name} registered`, {
      capabilities: card.capabilities,
      subscribes: card.subscribes,
      publishes: card.publishes,
    });
  }

  // Per-instance in-flight tracking — each bootstrapAgent owns its own set,
  // so shutting down one agent only waits for ITS work, not the whole process.
  const inFlight = new Set<Promise<void>>();
  const subscriptions: Subscription[] = [];

  for (const topic of card.subscribes) {
    const sub = transport.subscribe(topic, async (envelope) => {
      // Tenant isolation: drop messages not addressed to our tenant.
      // This is a CORRECTNESS guard — the transport itself still delivers
      // everything, we just ignore messages for other tenants.
      if (scopedTenantId !== undefined && envelope.metadata.tenantId !== scopedTenantId) {
        return;
      }

      const work = handleMessage({
        envelope,
        card,
        contextLoader,
        transport,
        createRuntime,
        toAgentInput,
        resultTopicFor,
        buildResultPayload,
        strictPublishLint,
        validateInput,
        validateOutput,
        logger,
      });
      inFlight.add(work);
      try {
        await work;
      } finally {
        inFlight.delete(work);
      }
    });
    subscriptions.push(sub);
  }

  logger.info(`Agent ${card.name} bootstrapped`, {
    subscribes: card.subscribes,
    publishes: card.publishes,
  });

  return {
    card,
    async shutdown() {
      for (const sub of subscriptions) sub.unsubscribe();
      // Wait for in-flight work (best-effort).
      await Promise.allSettled(Array.from(inFlight));
      // Unregister from the registry so stale cards don't stick around.
      if (registry) {
        try {
          await registry.unregister(card.name);
        } catch (err) {
          logger.warn(`Failed to unregister ${card.name}`, { err: String(err) });
        }
      }
      logger.info(`Agent ${card.name} shutdown`);
    },
  };
}

async function handleMessage(args: {
  envelope: MessageEnvelope;
  card: AgentCard;
  contextLoader: ContextLoader;
  transport: EventTransport;
  createRuntime: AgentBootstrapOptions['createRuntime'];
  toAgentInput: AgentBootstrapOptions['toAgentInput'];
  resultTopicFor?: AgentBootstrapOptions['resultTopicFor'];
  buildResultPayload?: AgentBootstrapOptions['buildResultPayload'];
  strictPublishLint: boolean;
  validateInput: (payload: unknown) => void;
  validateOutput: (payload: unknown) => void;
  logger: AgentLogger;
}): Promise<void> {
  const {
    envelope,
    card,
    contextLoader,
    transport,
    createRuntime,
    toAgentInput,
    strictPublishLint,
    logger,
  } = args;

  const tenantId = envelope.metadata.tenantId;

  try {
    // C3 FIX: enforce delegation depth limit if the message carries delegation metadata.
    // This works across processes because the delegate tool puts the depth into
    // RequestOptions, which the transport propagates into envelope.metadata.
    const delegationDepth = (envelope.metadata as { delegationDepth?: number }).delegationDepth;
    if (delegationDepth !== undefined && delegationDepth > 10) {
      args.logger.warn(`Delegation depth ${delegationDepth} exceeded max 10 — rejecting`, {
        callerAgent: (envelope.metadata as { callerAgent?: string }).callerAgent,
        topic: envelope.topic,
      });
      await args.transport.publish({
        id: messageId(),
        topic: `${envelope.topic}.failed`,
        type: 'result',
        payload: { error: `Delegation depth ${delegationDepth} exceeds limit` },
        metadata: {
          traceId: envelope.metadata.traceId,
          spanId: spanId(),
          parentSpanId: envelope.metadata.spanId,
          conversationId: envelope.metadata.conversationId,
          replyTo: envelope.id,
          tenantId,
          sourceInstanceId: card.name,
          timestamp: Date.now(),
        },
      });
      return;
    }

    // Schema validation: reject malformed inbound payloads BEFORE we spend
    // any context-loading or LLM budget on them. Schema errors go to a
    // dedicated `.schema-rejected` topic instead of `.failed` so operators
    // can distinguish "agent ran and errored" from "payload was never legal".
    try {
      args.validateInput(envelope.payload);
    } catch (err) {
      if (err instanceof SchemaValidationError) {
        args.logger.warn(`Schema-rejected inbound for ${card.name}`, { message: err.message });
        await args.transport.publish({
          id: messageId(),
          topic: `${envelope.topic}.schema-rejected`,
          type: 'result',
          payload: { error: err.message, errors: err.errors },
          metadata: {
            traceId: envelope.metadata.traceId,
            spanId: spanId(),
            parentSpanId: envelope.metadata.spanId,
            conversationId: envelope.metadata.conversationId,
            replyTo: envelope.id,
            tenantId,
            sourceInstanceId: card.name,
            timestamp: Date.now(),
          },
        });
        return;
      }
      throw err;
    }

    const context = await contextLoader.load(tenantId, card.name);
    const runtime = await createRuntime({ context, envelope });

    const input = toAgentInput(envelope);

    const events: AgentEvent[] = [];
    for await (const event of runtime.execute(input)) {
      events.push(event);
    }

    const resultTopic = args.resultTopicFor
      ? args.resultTopicFor(envelope)
      : (card.publishes[0] ?? `${envelope.topic}.completed`);

    // Publishes lint: the chosen result topic MUST match one of the card's
    // declared publishes patterns. Catches drift between the AgentCard and
    // actual behavior (e.g. an agent that silently started publishing to a
    // new topic without updating its card). Wildcards in card.publishes
    // (`*`, `#`) are honored.
    enforcePublishesLint({
      resultTopic,
      cardPublishes: card.publishes,
      cardName: card.name,
      strict: strictPublishLint,
      logger,
    });

    const payload = args.buildResultPayload
      ? args.buildResultPayload(events)
      : defaultResultPayload(events);

    // Output schema validation. A failure here is an AGENT BUG (it produced
    // a result that doesn't match its own declared outputSchema), so we
    // route to `.failed` like any other execution error.
    try {
      args.validateOutput(payload);
    } catch (err) {
      if (err instanceof SchemaValidationError) {
        throw err; // handled by the outer catch which publishes .failed
      }
      throw err;
    }

    const reply: MessageEnvelope = {
      id: messageId(),
      topic: resultTopic,
      type: 'result',
      payload,
      metadata: {
        traceId: envelope.metadata.traceId,
        spanId: spanId(),
        parentSpanId: envelope.metadata.spanId,
        conversationId: envelope.metadata.conversationId,
        replyTo: envelope.id,
        tenantId,
        sourceInstanceId: card.name,
        timestamp: Date.now(),
      },
    };

    await transport.publish(reply);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Agent ${card.name} failed`, { topic: envelope.topic, message });

    const errorTopic = `${envelope.topic}.failed`;
    await transport.publish({
      id: messageId(),
      topic: errorTopic,
      type: 'result',
      payload: { error: message },
      metadata: {
        traceId: envelope.metadata.traceId,
        spanId: spanId(),
        parentSpanId: envelope.metadata.spanId,
        conversationId: envelope.metadata.conversationId,
        replyTo: envelope.id,
        tenantId,
        sourceInstanceId: card.name,
        timestamp: Date.now(),
      },
    });
  }
}

/**
 * Enforce that `resultTopic` matches one of `cardPublishes` (wildcards honored).
 * In strict mode, a mismatch throws. In default mode, it logs a warning —
 * some deployments legitimately use dynamic routing the static card cannot
 * express.
 *
 * The `<incoming>.failed` error topic is always exempt: failure topics are
 * derived from the inbound topic, not from card.publishes, and requiring
 * operators to pre-declare every possible failure topic is unreasonable.
 */
function enforcePublishesLint(args: {
  resultTopic: string;
  cardPublishes: readonly TopicString[];
  cardName: string;
  strict: boolean;
  logger: AgentLogger;
}): void {
  // Exempt failure topics
  if (args.resultTopic.endsWith('.failed')) return;
  // Exempt if card declares no publishes at all (permissive mode)
  if (args.cardPublishes.length === 0) return;

  const matches = args.cardPublishes.some(pattern =>
    matchTopic(pattern, args.resultTopic as TopicString),
  );
  if (matches) return;

  const msg =
    `Agent "${args.cardName}" published to "${args.resultTopic}" which is not ` +
    `in card.publishes (${args.cardPublishes.join(', ') || '[]'}). ` +
    `Add it to the card or use resultTopicFor to route dynamically.`;
  if (args.strict) throw new Error(msg);
  args.logger.warn(msg);
}

function defaultResultPayload(events: AgentEvent[]): unknown {
  const errorEvent = events.find(e => e.type === 'error');
  if (errorEvent && errorEvent.type === 'error') {
    return { error: errorEvent.message };
  }
  const doneEvent = events.find(e => e.type === 'done');
  if (doneEvent && doneEvent.type === 'done') {
    return {
      content: doneEvent.content,
      toolCalls: doneEvent.toolCalls,
    };
  }
  return { content: '(no result)', toolCalls: [] };
}
