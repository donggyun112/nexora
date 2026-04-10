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
  AgentRuntime,
  AgentInput,
  AgentEvent,
  ContextLoader,
  Transport,
  Subscription,
  MessageEnvelope,
  AgentLogger,
} from '@nexora/contracts';
import { messageId, spanId } from '@nexora/contracts';

export interface AgentBootstrapOptions {
  /** 에이전트 카드 (subscribes/publishes 정의) */
  card: AgentCard;
  /** 컨텍스트 로더 */
  contextLoader: ContextLoader;
  /** Transport */
  transport: Transport;
  /**
   * 컨텍스트가 주입된 후 AgentRuntime을 생성하는 팩토리.
   * 매 요청마다 호출되며, 전체 AgentContext(systemPrompt + tools + limits + runtime)를 받는다.
   * 팩토리는 limits로 모델/토큰/timeout을 설정하고, runtime.workdir로 ToolContext를 만들어야 한다.
   */
  createRuntime: (args: {
    context: AgentContext;
    envelope: MessageEnvelope;
  }) => AgentRuntime | Promise<AgentRuntime>;
  /**
   * 수신된 메시지 payload를 AgentInput으로 변환.
   * 각 에이전트가 도메인 schema에 맞게 구현.
   */
  toAgentInput: (envelope: MessageEnvelope) => AgentInput;
  /**
   * 에이전트 결과를 어떤 topic으로 발행할지 결정.
   * 기본: 첫 번째 publishes 토픽 또는 `<original>.completed`
   */
  resultTopicFor?: (envelope: MessageEnvelope) => string;
  /**
   * 에이전트 결과 payload 조립.
   * 기본: { content, toolCalls, error }
   */
  buildResultPayload?: (events: AgentEvent[]) => unknown;
  /** 로거 */
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
 * 에이전트 부팅 — 모든 subscribes 토픽 구독 시작.
 */
export async function bootstrapAgent(options: AgentBootstrapOptions): Promise<RunningAgent> {
  const {
    card,
    contextLoader,
    transport,
    createRuntime,
    toAgentInput,
    resultTopicFor,
    buildResultPayload,
  } = options;
  const logger = options.logger ?? NOOP_LOGGER;

  if (card.subscribes.length === 0) {
    logger.warn(`Agent ${card.name} has no subscribes`);
  }

  // Per-instance in-flight tracking — each bootstrapAgent owns its own set,
  // so shutting down one agent only waits for ITS work, not the whole process.
  const inFlight = new Set<Promise<void>>();
  const subscriptions: Subscription[] = [];

  for (const topic of card.subscribes) {
    const sub = transport.subscribe(topic, async (envelope) => {
      const work = handleMessage({
        envelope,
        card,
        contextLoader,
        transport,
        createRuntime,
        toAgentInput,
        resultTopicFor,
        buildResultPayload,
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
      // in-flight 작업 완료 대기 (best-effort)
      await Promise.allSettled(Array.from(inFlight));
      logger.info(`Agent ${card.name} shutdown`);
    },
  };
}

async function handleMessage(args: {
  envelope: MessageEnvelope;
  card: AgentCard;
  contextLoader: ContextLoader;
  transport: Transport;
  createRuntime: AgentBootstrapOptions['createRuntime'];
  toAgentInput: AgentBootstrapOptions['toAgentInput'];
  resultTopicFor?: AgentBootstrapOptions['resultTopicFor'];
  buildResultPayload?: AgentBootstrapOptions['buildResultPayload'];
  logger: AgentLogger;
}): Promise<void> {
  const {
    envelope,
    card,
    contextLoader,
    transport,
    createRuntime,
    toAgentInput,
    logger,
  } = args;

  const tenantId = envelope.metadata.tenantId;

  try {
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

    const payload = args.buildResultPayload
      ? args.buildResultPayload(events)
      : defaultResultPayload(events);

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
