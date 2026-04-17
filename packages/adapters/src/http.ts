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
header{padding:14px 24px;border-bottom:1px solid #1a1a1a;display:flex;align-items:center;gap:12px}
header h1{font-size:17px;font-weight:600;color:#fff}
header .tag{font-size:11px;color:#888;background:#141414;padding:2px 8px;border-radius:4px;border:1px solid #222}
#chat{flex:1;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:14px}
.msg{max-width:760px;line-height:1.55;font-size:14px;white-space:pre-wrap;word-break:break-word}
.user-row{align-self:flex-end;display:flex;flex-direction:column;align-items:flex-end}
.user-row .bubble{background:#1d4ed8;color:#fff;padding:10px 16px;border-radius:14px 14px 4px 14px}
.agent-row{align-self:flex-start;display:flex;flex-direction:column;gap:6px;max-width:760px;width:100%}
.agent-row .bubble{background:#141414;border:1px solid #222;padding:12px 16px;border-radius:4px 14px 14px 14px}
.agent-row .bubble:empty{display:none}
.tools{display:flex;flex-direction:column;gap:4px}
.tool-ev{font-size:12px;padding:5px 10px;border-radius:6px;display:flex;align-items:center;gap:6px;font-family:ui-monospace,monospace}
.tool-call{background:#0c1a2e;border:1px solid #1a3050;color:#60a5fa}
.tool-result{background:#0a1a0a;border:1px solid #1a3a1a;color:#4ade80}
.tool-result.err{background:#1a0a0a;border:1px solid #3a1a1a;color:#f87171}
.tool-ev .icon{font-size:14px}
.tool-ev .name{font-weight:600}
.tool-ev .dur{color:#555;margin-left:auto}
.delegate-ev{background:#1a0a2e;border:1px solid #2a1a50;color:#a78bfa}
.thinking-ev{font-size:12px;color:#555;font-style:italic;padding:2px 0}
.meta{font-size:11px;color:#444;margin-top:4px}
.typing{color:#555;font-size:13px;padding:4px 0}
.typing span{animation:blink 1.4s infinite both}
.typing span:nth-child(2){animation-delay:.2s}
.typing span:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}
#bar{padding:14px 24px;border-top:1px solid #1a1a1a;display:flex;gap:8px}
#bar input{flex:1;padding:11px 16px;border-radius:10px;border:1px solid #282828;background:#111;color:#fff;font-size:14px;outline:none}
#bar input:focus{border-color:#1d4ed8}
#bar button{padding:11px 20px;border-radius:10px;border:none;background:#1d4ed8;color:#fff;font-size:14px;cursor:pointer;font-weight:500}
#bar button:disabled{background:#222;color:#555;cursor:not-allowed}
</style>
</head>
<body>
<header>
<h1>⚡ Nexora</h1>
<span class="tag">streaming</span>
</header>
<div id="chat"></div>
<div id="bar">
<input id="inp" placeholder="메시지를 입력하세요..." autocomplete="off">
<button id="btn">Send</button>
</div>
<script>
const chat=document.getElementById('chat'),inp=document.getElementById('inp'),btn=document.getElementById('btn');
function h(s){const d=document.createElement('div');d.innerHTML=s;return d.textContent||''}
function scroll(){chat.scrollTop=chat.scrollHeight}

function addUser(text){
  const row=document.createElement('div');row.className='msg user-row';
  row.innerHTML='<div class="bubble"></div>';
  row.querySelector('.bubble').textContent=text;
  chat.appendChild(row);scroll();
}

function createAgent(){
  const row=document.createElement('div');row.className='msg agent-row';
  row.innerHTML='<div class="tools"></div><div class="bubble"></div><div class="meta"></div>';
  chat.appendChild(row);scroll();
  return {
    el:row,
    tools:row.querySelector('.tools'),
    bubble:row.querySelector('.bubble'),
    meta:row.querySelector('.meta'),
    _t0:Date.now(),_tc:0,_tokens:0,
    addTool(name,type,isErr){
      this._tc++;
      const d=document.createElement('div');
      const cls=name==='delegate'?'tool-ev delegate-ev':type==='call'?'tool-ev tool-call':('tool-ev tool-result'+(isErr?' err':''));
      d.className=cls;
      const icon=name==='delegate'?'🤝':name==='read'?'📄':name==='grep'?'🔍':name==='exec'?'⚡':'🔧';
      d.innerHTML='<span class="icon">'+icon+'</span><span class="name">'+h(name)+'</span>';
      this.tools.appendChild(d);scroll();
      return d;
    },
    appendText(t){this.bubble.textContent+=t;scroll()},
    addThinking(t){
      const d=document.createElement('div');d.className='thinking-ev';d.textContent='💭 '+t.slice(0,120);
      this.tools.appendChild(d);scroll();
    },
    finish(){
      const ms=Date.now()-this._t0;
      const parts=[ms>1000?(ms/1000).toFixed(1)+'s':ms+'ms'];
      if(this._tc)parts.push(this._tc+' tool'+(this._tc>1?'s':''));
      this.meta.textContent=parts.join(' · ');
    }
  };
}

async function send(){
  const text=inp.value.trim();if(!text)return;
  inp.value='';addUser(text);
  btn.disabled=true;inp.disabled=true;
  const typing=document.createElement('div');typing.className='typing';
  typing.innerHTML='<span>●</span><span>●</span><span>●</span>';
  chat.appendChild(typing);scroll();

  const agent=createAgent();
  try{
    const res=await fetch('/messages/stream',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({content:text})
    });
    typing.remove();
    const reader=res.body.getReader();
    const dec=new TextDecoder();
    let buf='';
    while(true){
      const{done,value}=await reader.read();
      if(done)break;
      buf+=dec.decode(value,{stream:true});
      const lines=buf.split('\\n\\n');buf=lines.pop()||'';
      for(const line of lines){
        if(!line.startsWith('data: '))continue;
        try{
          const c=JSON.parse(line.slice(6));
          if(c.type==='text')agent.appendText(c.text);
          else if(c.type==='tool_call')agent.addTool(c.name,'call');
          else if(c.type==='tool_result')agent.addTool(c.name,'result',c.isError);
          else if(c.type==='thinking')agent.addThinking(c.content);
          else if(c.type==='error')agent.appendText('[Error] '+c.message);
        }catch{}
      }
      scroll();
    }
  }catch(e){typing.remove();agent.appendText('Error: '+e.message)}
  agent.finish();
  btn.disabled=false;inp.disabled=false;inp.focus();
}

btn.addEventListener('click',send);
inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
inp.focus();
</script>
</body>
</html>`;
