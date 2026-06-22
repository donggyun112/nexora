/**
 * StreamingGatewayRouter — true token-level SSE streaming.
 *
 * The original GatewayRouter uses transport.request() which waits for the
 * full response before returning — routeStream() was faking it by calling
 * route() then emitting the complete text as one chunk.
 *
 * This router takes a different approach: it skips the transport entirely
 * for the streaming path and calls AgentRuntime.execute() directly (via
 * a factory), forwarding each AgentEvent as an SSE chunk in real time.
 *
 * For the non-streaming route() path, it still delegates to the inner
 * GatewayRouter (transport-based request/reply).
 */

import type {
  MessageRouter,
  InboundMessage,
  OutboundMessage,
  OutboundChunk,
  AgentRuntime,
  AgentEvent,
} from '@dongkseo/contracts';

export interface StreamingGatewayRouterOptions {
  /** The non-streaming router for route() calls. */
  inner: MessageRouter;
  /**
   * Factory that creates an AgentRuntime for a given inbound message.
   * Called once per routeStream() request. The runtime's execute() generator
   * is consumed event-by-event for true SSE streaming.
   */
  createRuntime: (message: InboundMessage) => AgentRuntime | Promise<AgentRuntime>;
}

export class StreamingGatewayRouter implements MessageRouter {
  private readonly inner: MessageRouter;
  private readonly createRuntime: StreamingGatewayRouterOptions['createRuntime'];

  constructor(options: StreamingGatewayRouterOptions) {
    this.inner = options.inner;
    this.createRuntime = options.createRuntime;
  }

  /** Non-streaming: delegate to inner transport-based router. */
  async route(message: InboundMessage): Promise<OutboundMessage> {
    return this.inner.route(message);
  }

  /** True streaming: create runtime, consume events, forward as chunks. */
  async routeStream(
    message: InboundMessage,
    onChunk: (chunk: OutboundChunk) => void,
  ): Promise<void> {
    const runtime = await this.createRuntime(message);

    for await (const event of runtime.execute({
      prompt: message.content,
      images: message.images?.map(i => ({ type: 'image', data: i.data, mimeType: i.mimeType })),
      files: message.files?.map(f => ({ ...f, type: 'file' as const })),
    })) {
      const chunk = mapEvent(event);
      if (chunk) onChunk(chunk);
    }
  }
}

function mapEvent(event: AgentEvent): OutboundChunk | null {
  switch (event.type) {
    case 'text': return { type: 'text', text: event.text };
    case 'artifact': return { type: 'artifact', artifact: event.artifact };
    case 'tool_call': return { type: 'tool_call', name: event.name };
    case 'tool_result': return { type: 'tool_result', name: event.name, isError: event.isError };
    case 'thinking': return { type: 'thinking', content: event.content };
    case 'done': return { type: 'done', content: event.content };
    case 'error': return { type: 'error', message: event.message };
    default: return null;
  }
}
