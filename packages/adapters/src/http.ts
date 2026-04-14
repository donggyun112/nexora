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

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(TEST_PAGE_HTML);
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

// ─── Built-in test page ───────────────────────────────────────────────────

const TEST_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexora</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#e5e5e5;height:100vh;display:flex;flex-direction:column}
  header{padding:16px 24px;border-bottom:1px solid #222;display:flex;align-items:center;gap:12px}
  header h1{font-size:18px;font-weight:600;color:#fff}
  header span{font-size:12px;color:#666;background:#1a1a1a;padding:2px 8px;border-radius:4px}
  #chat{flex:1;overflow-y:auto;padding:24px;display:flex;flex-direction:column;gap:12px}
  .msg{max-width:720px;padding:12px 16px;border-radius:12px;line-height:1.5;font-size:14px;white-space:pre-wrap;word-break:break-word}
  .user{background:#1e3a5f;align-self:flex-end;border-bottom-right-radius:4px}
  .agent{background:#1a1a1a;border:1px solid #222;align-self:flex-start;border-bottom-left-radius:4px}
  .agent .tool{color:#888;font-size:12px;font-style:italic}
  .system{color:#666;font-size:12px;text-align:center;align-self:center}
  #input-area{padding:16px 24px;border-top:1px solid #222;display:flex;gap:8px}
  #input{flex:1;padding:10px 16px;border-radius:8px;border:1px solid #333;background:#111;color:#fff;font-size:14px;outline:none}
  #input:focus{border-color:#4a9eff}
  #input::placeholder{color:#555}
  button{padding:10px 20px;border-radius:8px;border:none;background:#4a9eff;color:#fff;font-size:14px;cursor:pointer;font-weight:500}
  button:hover{background:#3a8eef}
  button:disabled{background:#333;color:#666;cursor:not-allowed}
  #mode{display:flex;gap:8px;align-items:center}
  #mode label{font-size:12px;color:#888;cursor:pointer}
  #mode input{accent-color:#4a9eff}
  .typing{color:#888;font-size:13px;padding:8px 16px}
  .typing::after{content:'';animation:dots 1.5s infinite}
  @keyframes dots{0%{content:''}33%{content:'.'}66%{content:'..'}100%{content:'...'}}
</style>
</head>
<body>
<header>
  <h1>Nexora</h1>
  <span>Agent Test Console</span>
  <div style="flex:1"></div>
  <div id="mode">
    <label><input type="checkbox" id="stream-toggle" checked> Stream</label>
  </div>
</header>
<div id="chat"></div>
<div id="input-area">
  <input id="input" placeholder="Type a message..." autocomplete="off">
  <button id="send">Send</button>
</div>
<script>
const chat=document.getElementById('chat');
const input=document.getElementById('input');
const sendBtn=document.getElementById('send');
const streamToggle=document.getElementById('stream-toggle');

function addMsg(text,cls){
  const d=document.createElement('div');
  d.className='msg '+cls;
  d.textContent=text;
  chat.appendChild(d);
  chat.scrollTop=chat.scrollHeight;
  return d;
}

async function send(){
  const text=input.value.trim();
  if(!text)return;
  input.value='';
  addMsg(text,'user');
  sendBtn.disabled=true;
  input.disabled=true;

  try{
    if(streamToggle.checked){
      const el=addMsg('','agent');
      const typing=document.createElement('div');
      typing.className='typing';
      typing.textContent='Thinking';
      chat.appendChild(typing);
      chat.scrollTop=chat.scrollHeight;

      const res=await fetch('/messages/stream',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({content:text})
      });
      typing.remove();

      const reader=res.body.getReader();
      const decoder=new TextDecoder();
      let buf='';
      while(true){
        const{done,value}=await reader.read();
        if(done)break;
        buf+=decoder.decode(value,{stream:true});
        const lines=buf.split('\\n\\n');
        buf=lines.pop()||'';
        for(const line of lines){
          if(!line.startsWith('data: '))continue;
          try{
            const chunk=JSON.parse(line.slice(6));
            if(chunk.type==='text')el.textContent+=chunk.text;
            else if(chunk.type==='tool_call')el.innerHTML+='<div class="tool">Using '+chunk.name+'...</div>';
            else if(chunk.type==='error')el.textContent+='[Error] '+chunk.message;
          }catch{}
        }
        chat.scrollTop=chat.scrollHeight;
      }
      if(!el.textContent.trim())el.textContent='(no response)';
    }else{
      const typing=document.createElement('div');
      typing.className='typing';
      typing.textContent='Thinking';
      chat.appendChild(typing);

      const res=await fetch('/messages',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({content:text})
      });
      typing.remove();
      const data=await res.json();
      addMsg(data.content||data.error||'(no response)','agent');
    }
  }catch(e){
    addMsg('Error: '+e.message,'system');
  }
  sendBtn.disabled=false;
  input.disabled=false;
  input.focus();
}

sendBtn.addEventListener('click',send);
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
addMsg('Connected to Nexora. Type a message to start.','system');
input.focus();
</script>
</body>
</html>`;
