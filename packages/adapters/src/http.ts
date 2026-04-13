/**
 * HttpAdapter — REST API 진입점.
 *
 * node:http 기반 (express 비의존). Adapter 인터페이스 구현.
 *
 * 엔드포인트:
 *   POST /messages  → router.route(InboundMessage) → JSON 응답
 *   POST /messages/stream → SSE 스트림 (router.routeStream)
 *
 * 인증/테넌트 해석은 외부에서 주입한 `resolveTenant` 함수가 담당.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type {
  Adapter,
  MessageRouter,
  InboundMessage,
  OutboundChunk,
} from '@nexora/contracts';

export interface HttpAdapterOptions {
  /** 바인드 호스트 (기본 '127.0.0.1') */
  host?: string;
  /** 바인드 포트 (기본 0 = 자동) */
  port?: number;
  /**
   * 인증/테넌트 해석. 헤더/토큰을 보고 tenantId 반환.
   * 인증 실패 시 null 반환.
   */
  resolveTenant?: (req: IncomingMessage) => Promise<string | null> | string | null;
}

export class HttpAdapter implements Adapter {
  readonly name = 'http';
  private server: Server | null = null;
  private boundPort: number | null = null;
  private readonly host: string;
  private readonly desiredPort: number;
  private readonly resolveTenant: NonNullable<HttpAdapterOptions['resolveTenant']>;

  constructor(options: HttpAdapterOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.desiredPort = options.port ?? 0;
    this.resolveTenant = options.resolveTenant ?? (() => 'default');
  }

  async start(router: MessageRouter): Promise<void> {
    if (this.server) throw new Error('HttpAdapter already started');

    this.server = createServer((req, res) => {
      void this.handle(req, res, router);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.desiredPort, this.host, () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') this.boundPort = addr.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close(err => err ? reject(err) : resolve());
    });
    this.server = null;
  }

  /** 바인드된 실제 포트 */
  port(): number | null {
    return this.boundPort;
  }

  // ─── handlers ────────────────────────────────────────────────────────────

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
    router: MessageRouter,
  ): Promise<void> {
    if (req.method === 'GET' && req.url === '/health') {
      this.sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'POST' && req.url === '/messages') {
      await this.handleMessages(req, res, router);
      return;
    }

    if (req.method === 'POST' && req.url === '/messages/stream') {
      await this.handleStream(req, res, router);
      return;
    }

    this.sendJson(res, 404, { error: 'not found' });
  }

  private async handleMessages(
    req: IncomingMessage,
    res: ServerResponse,
    router: MessageRouter,
  ): Promise<void> {
    try {
      const tenantId = await this.resolveTenant(req);
      if (tenantId === null) {
        this.sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      const body = await readJsonBody(req);
      const inbound = normalizeInbound(body, tenantId);
      const out = await router.route(inbound);
      this.sendJson(res, 200, out);
    } catch (err) {
      if (isRateLimitError(err)) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.ceil((err as { retryAfterMs: number }).retryAfterMs / 1000)),
        });
        res.end(JSON.stringify({ error: 'rate limit exceeded' }));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.sendJson(res, 400, { error: message });
    }
  }

  private async handleStream(
    req: IncomingMessage,
    res: ServerResponse,
    router: MessageRouter,
  ): Promise<void> {
    try {
      let tenantId: string | null;
      try {
        tenantId = await this.resolveTenant(req);
      } catch (err) {
        if (isRateLimitError(err)) {
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': String(Math.ceil((err as { retryAfterMs: number }).retryAfterMs / 1000)),
          });
          res.end(JSON.stringify({ error: 'rate limit exceeded' }));
          return;
        }
        throw err;
      }
      if (tenantId === null) {
        this.sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      const body = await readJsonBody(req);
      const inbound = normalizeInbound(body, tenantId);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const onChunk = (chunk: OutboundChunk): void => {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      };

      try {
        await router.routeStream(inbound, onChunk);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      }
      res.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendJson(res, 400, { error: message });
    }
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`invalid JSON body: ${(err as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

function normalizeInbound(
  body: Record<string, unknown>,
  tenantId: string,
): InboundMessage {
  const content = typeof body.content === 'string' ? body.content : '';
  if (!content) throw new Error('content is required');

  return {
    platform: 'http',
    channelId: typeof body.channelId === 'string' ? body.channelId : 'default',
    userId: typeof body.userId === 'string' ? body.userId : 'anonymous',
    displayName: typeof body.displayName === 'string' ? body.displayName : 'http-user',
    content,
    images: Array.isArray(body.images)
      ? body.images.filter(isImage)
      : undefined,
    tenantId,
    conversationId: typeof body.conversationId === 'string' ? body.conversationId : undefined,
  };
}

function isRateLimitError(err: unknown): boolean {
  return err instanceof Error && err.name === 'RateLimitError';
}

function isImage(x: unknown): x is { data: string; mimeType: string } {
  return !!x && typeof x === 'object'
    && typeof (x as { data?: unknown }).data === 'string'
    && typeof (x as { mimeType?: unknown }).mimeType === 'string';
}
