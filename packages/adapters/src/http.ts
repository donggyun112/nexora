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
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{font-family:'gg sans','Noto Sans',Helvetica,Arial,sans-serif;background:#313338;color:#dbdee1}
.app{display:flex;flex-direction:column;height:100%}
header{display:flex;align-items:center;gap:14px;padding:12px 16px;background:#2b2d31;border-bottom:1px solid #1e1f22}
header h1{font-size:16px;font-weight:600;color:#f2f3f5}
.tags{display:flex;gap:6px}
.tag{font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid;background:transparent}
.msgs{flex:1;overflow-y:auto;padding:16px 0}
.msgs::-webkit-scrollbar{width:8px}
.msgs::-webkit-scrollbar-thumb{background:#1e1f22;border-radius:4px}
.empty{text-align:center;color:#5c5e66;padding:40px 16px;font-size:14px}
.mrow{display:flex;padding:4px 16px;gap:12px}
.mrow:hover{background:#2e3035}
.mrow.user{justify-content:flex-end}
.ubbl{background:#5865f2;color:#fff;padding:8px 14px;border-radius:16px 16px 4px 16px;max-width:520px;font-size:14px;line-height:1.5;word-break:break-word}
.av{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.mc{min-width:0;max-width:640px}
.an{font-size:14px;font-weight:600;margin-bottom:2px}
.abbl{font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;padding:2px 0}
.tc{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0}
.tch{font-size:12px;padding:2px 8px;border-radius:4px;font-family:monospace;display:inline-flex;align-items:center;gap:4px}
.tch.c{background:#1e2a45;color:#5dadec}
.tch.r{background:#1a2e1a;color:#57d28f}
.tch.e{background:#2e1a1a;color:#ed4245}
.typ{color:#5c5e66;font-size:13px;padding:4px 16px}
.typ span{animation:bl 1.4s infinite both}
.typ span:nth-child(2){animation-delay:.2s}
.typ span:nth-child(3){animation-delay:.4s}
@keyframes bl{0%,80%,100%{opacity:.2}40%{opacity:1}}
.bar{display:flex;padding:0 16px 24px}
.bar input{flex:1;padding:12px 16px;background:#383a40;border:none;border-radius:8px 0 0 8px;color:#dbdee1;font-size:14px;outline:none}
.bar input::placeholder{color:#5c5e66}
.bar input:focus{background:#404249}
.bar button{padding:12px 20px;background:#5865f2;color:#fff;border:none;border-radius:0 8px 8px 0;font-size:14px;font-weight:600;cursor:pointer}
.bar button:disabled{background:#383a40;color:#5c5e66;cursor:not-allowed}
</style>
</head>
<body>
<div class="app">
<header>
<h1>⚡ Nexora</h1>
<div class="tags">
<span class="tag" style="border-color:#5865f2;color:#5865f2">🤖 assistant</span>
<span class="tag" style="border-color:#9b59b6;color:#9b59b6">💻 coder</span>
<span class="tag" style="border-color:#2ecc71;color:#2ecc71">🔍 researcher</span>
</div>
</header>
<div class="msgs" id="msgs">
<div class="empty">메시지를 보내면 에이전트들이 협업하여 응답합니다.</div>
</div>
<div class="bar">
<input id="inp" placeholder="메시지를 입력하세요..." autocomplete="off">
<button id="btn">Send</button>
</div>
</div>
<script>
const A={assistant:{av:'🤖',c:'#5865f2'},coder:{av:'💻',c:'#9b59b6'},researcher:{av:'🔍',c:'#2ecc71'},system:{av:'⚠️',c:'#e74c3c'}};
const TI={read:'📄',grep:'🔍',exec:'⚡',write:'✏️',edit:'✏️',delegate:'🤝',knowledge:'📚'};
const msgs=document.getElementById('msgs'),inp=document.getElementById('inp'),btn=document.getElementById('btn');
let first=true;
function scroll(){msgs.scrollTop=msgs.scrollHeight}
function h(s){const d=document.createElement('span');d.textContent=s;return d.textContent}

function addUser(text){
  if(first){msgs.innerHTML='';first=false}
  const r=document.createElement('div');r.className='mrow user';
  r.innerHTML='<div class="ubbl"></div>';
  r.querySelector('.ubbl').textContent=text;
  msgs.appendChild(r);scroll();
}

const agentEls=new Map();
function getAgent(name){
  if(agentEls.has(name))return agentEls.get(name);
  const a=A[name]||A.system;
  const r=document.createElement('div');r.className='mrow';
  r.innerHTML='<div class="av" style="background:'+a.c+'">'+a.av+'</div><div class="mc"><div class="an" style="color:'+a.c+'">'+h(name)+'</div><div class="tc"></div><div class="abbl"></div></div>';
  msgs.appendChild(r);scroll();
  const o={el:r,tc:r.querySelector('.tc'),bbl:r.querySelector('.abbl')};
  agentEls.set(name,o);
  return o;
}

async function send(){
  const text=inp.value.trim();if(!text)return;
  inp.value='';addUser(text);
  agentEls.clear();
  btn.disabled=true;inp.disabled=true;
  const typ=document.createElement('div');typ.className='typ';
  typ.innerHTML='<span>●</span><span>●</span><span>●</span>';
  msgs.appendChild(typ);scroll();
  try{
    const res=await fetch('/messages/stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:text})});
    typ.remove();
    const rd=res.body.getReader(),dc=new TextDecoder();
    let buf='';
    while(true){
      const{done,value}=await rd.read();
      if(done)break;
      buf+=dc.decode(value,{stream:true});
      const lines=buf.split('\n\n');buf=lines.pop()||'';
      for(const line of lines){
        if(!line.startsWith('data: '))continue;
        try{
          const c=JSON.parse(line.slice(6));
          const ag=c.agent||'assistant';
          if(c.type==='text'){const o=getAgent(ag);o.bbl.textContent+=c.text||''}
          else if(c.type==='tool_call'){
            const o=getAgent(ag);
            const icon=TI[c.name]||'🔧';
            let det='';
            if(c.input){
              if(c.name==='read'&&c.input.path)det=' '+c.input.path;
              else if(c.name==='grep'&&c.input.pattern)det=' /'+c.input.pattern+'/';
              else if(c.name==='delegate'&&c.input.capability)det=' → @'+c.input.capability;
            }
            o.tc.insertAdjacentHTML('beforeend','<span class="tch c">'+icon+' '+h(c.name)+h(det)+'</span>');
          }
          else if(c.type==='tool_result'){const o=getAgent(ag);o.tc.insertAdjacentHTML('beforeend','<span class="tch '+(c.isError?'e':'r')+'">✓ '+h(c.name)+'</span>')}
          else if(c.type==='delegate_start'&&c.to){getAgent(c.to)}
          else if(c.type==='error'){const o=getAgent(ag);o.bbl.textContent+='[Error] '+(c.message||'')}
        }catch{}
      }
      scroll();
    }
  }catch(e){typ.remove();const o=getAgent('system');o.bbl.textContent='Error: '+e.message}
  btn.disabled=false;inp.disabled=false;inp.focus();
}
btn.addEventListener('click',send);
inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
inp.focus();
</script>
</div>
</body>
</html>`;
