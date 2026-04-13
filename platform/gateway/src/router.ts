/**
 * GatewayRouter — InboundMessage → topic publish 라우팅.
 *
 * 책임:
 *   1. InboundMessage를 적절한 topic으로 변환
 *   2. transport.request()로 발행 (request/reply 패턴)
 *   3. 응답을 OutboundMessage로 정규화
 *
 * 토픽 결정 전략:
 *   - 명시적 IntentResolver가 있으면 그 결과 사용
 *   - 없으면 기본 topic 사용
 */

import type {
  MessageRouter,
  InboundMessage,
  OutboundMessage,
  OutboundChunk,
  Transport,
  TopicString,
  AgentLogger,
  AgentRuntime,
  AgentEvent,
} from '@nexora/contracts';

export interface IntentResolver {
  /** 입력 메시지를 보고 발행할 topic 결정 */
  resolve(message: InboundMessage): Promise<TopicString> | TopicString;
}

/**
 * Mention-based intent resolver — routes messages to agent topics
 * based on the `metadata.mentionedAgent` field set by DiscordAdapter.
 *
 * Usage:
 * ```ts
 * const router = new GatewayRouter({
 *   transport,
 *   defaultTopic: topic('group.requested'),
 *   intentResolver: createMentionResolver(),
 * });
 * ```
 */
export function createMentionResolver(options?: {
  /** Topic pattern. Default: `{agentName}.requested` */
  topicPattern?: (agentName: string) => TopicString;
}): IntentResolver {
  const toTopic = options?.topicPattern ?? ((name: string) => `${name}.requested` as TopicString);
  return {
    resolve(message: InboundMessage): TopicString {
      const mentioned = (message.metadata as Record<string, unknown> | undefined)?.mentionedAgent;
      if (typeof mentioned === 'string') return toTopic(mentioned);
      // Return empty string — GatewayRouter falls back to defaultTopic
      return '' as TopicString;
    },
  };
}

export interface GatewayRouterOptions {
  transport: Transport;
  /** 기본 topic (resolver가 없거나 아무것도 매칭 안 될 때) */
  defaultTopic: TopicString;
  /** 인텐트 분류기 (선택) */
  intentResolver?: IntentResolver;
  /** request timeout (ms, 기본 60000) */
  timeoutMs?: number;
  logger?: AgentLogger;
}

const NOOP_LOGGER: AgentLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
};

export class GatewayRouter implements MessageRouter {
  private readonly transport: Transport;
  private readonly defaultTopic: TopicString;
  private readonly intentResolver?: IntentResolver;
  private readonly timeoutMs: number;
  private readonly logger: AgentLogger;

  constructor(options: GatewayRouterOptions) {
    this.transport = options.transport;
    this.defaultTopic = options.defaultTopic;
    this.intentResolver = options.intentResolver;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  async route(message: InboundMessage): Promise<OutboundMessage> {
    const topic = await this.resolveTopic(message);
    this.logger.info('gateway.route', {
      topic,
      tenantId: message.tenantId,
      platform: message.platform,
    });

    const reply = await this.transport.request(
      topic,
      this.toPayload(message),
      {
        timeoutMs: this.timeoutMs,
        tenantId: message.tenantId,
        conversationId: message.conversationId,
      },
    );

    return this.toOutbound(reply.payload);
  }

  async routeStream(
    message: InboundMessage,
    onChunk: (chunk: OutboundChunk) => void,
  ): Promise<void> {
    // 기본 구현: 비스트리밍으로 처리 후 마지막 chunk만 전송.
    // 실제 스트리밍은 Gateway가 직접 LocalRuntimeRouter 등을 사용할 때 유용.
    try {
      const out = await this.route(message);
      onChunk({ type: 'text', text: out.content });
      onChunk({ type: 'done', content: out.content });
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      onChunk({ type: 'error', message: messageText });
    }
  }

  private async resolveTopic(message: InboundMessage): Promise<TopicString> {
    if (this.intentResolver) {
      const resolved = await this.intentResolver.resolve(message);
      // Empty/falsy result → fall back to default topic
      if (resolved) return resolved;
    }
    return this.defaultTopic;
  }

  private toPayload(message: InboundMessage): unknown {
    return {
      prompt: message.content,
      requesterId: message.userId,
      requesterName: message.displayName,
      images: message.images,
      channelId: message.channelId,
    };
  }

  private toOutbound(payload: unknown): OutboundMessage {
    if (!payload || typeof payload !== 'object') {
      return { content: String(payload) };
    }
    const p = payload as { content?: string; error?: string; [k: string]: unknown };
    if (typeof p.error === 'string') return { content: `[ERROR] ${p.error}` };
    if (typeof p.content === 'string') return { content: p.content, metadata: p };
    return { content: JSON.stringify(payload) };
  }
}

/**
 * LocalRuntimeRouter — transport 없이 AgentRuntime을 직접 호출하는 라우터.
 *
 * 단일 프로세스 + 스트리밍이 필요한 경우 (HTTP SSE 등) 유용.
 */
export interface LocalRuntimeRouterOptions {
  /** InboundMessage → AgentRuntime 인스턴스를 만드는 팩토리 (테넌트별 분기 가능) */
  createRuntime: (message: InboundMessage) => AgentRuntime | Promise<AgentRuntime>;
}

export class LocalRuntimeRouter implements MessageRouter {
  constructor(private readonly options: LocalRuntimeRouterOptions) {}

  async route(message: InboundMessage): Promise<OutboundMessage> {
    const runtime = await this.options.createRuntime(message);
    let lastContent = '';
    for await (const event of runtime.execute({
      prompt: message.content,
      images: message.images?.map(i => ({ type: 'image', data: i.data, mimeType: i.mimeType })),
    })) {
      if (event.type === 'done') lastContent = event.content;
      if (event.type === 'error') throw new Error(event.message);
    }
    return { content: lastContent };
  }

  async routeStream(
    message: InboundMessage,
    onChunk: (chunk: OutboundChunk) => void,
  ): Promise<void> {
    const runtime = await this.options.createRuntime(message);
    for await (const event of runtime.execute({
      prompt: message.content,
      images: message.images?.map(i => ({ type: 'image', data: i.data, mimeType: i.mimeType })),
    })) {
      const chunk = mapEventToChunk(event);
      if (chunk) onChunk(chunk);
    }
  }
}

function mapEventToChunk(event: AgentEvent): OutboundChunk | null {
  switch (event.type) {
    case 'text': return { type: 'text', text: event.text };
    case 'tool_call': return { type: 'tool_call', name: event.name };
    case 'tool_result': return { type: 'tool_result', name: event.name, isError: event.isError };
    case 'thinking': return { type: 'thinking', content: event.content };
    case 'done': return { type: 'done', content: event.content };
    case 'error': return { type: 'error', message: event.message };
    default: return null;
  }
}
