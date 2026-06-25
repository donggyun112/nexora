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

import { Buffer } from 'node:buffer';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type {
  Adapter,
  MessageRouter,
  InboundMessage,
  OutboundChunk,
  FileContent,
  LLMMessage,
} from '@dongkseo/contracts';

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
  /** Maximum accepted input files per request. Default: 10. */
  maxFiles?: number;
  /** Maximum decoded bytes per input file. Default: 10 MiB. */
  maxFileBytes?: number;
  /** Maximum decoded bytes across all input files. Default: 25 MiB. */
  maxTotalFileBytes?: number;
}

interface InputFileLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalFileBytes: number;
}

const DEFAULT_INPUT_FILE_LIMITS: InputFileLimits = {
  maxFiles: 10,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalFileBytes: 25 * 1024 * 1024,
};

export class HttpAdapter implements Adapter {
  readonly name = 'http';
  private server: Server | null = null;
  private boundPort: number | null = null;
  private readonly host: string;
  private readonly desiredPort: number;
  private readonly resolveTenant: NonNullable<HttpAdapterOptions['resolveTenant']>;
  private readonly fileLimits: InputFileLimits;

  constructor(options: HttpAdapterOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.desiredPort = options.port ?? 0;
    this.resolveTenant = options.resolveTenant ?? (() => 'default');
    this.fileLimits = {
      maxFiles: options.maxFiles ?? DEFAULT_INPUT_FILE_LIMITS.maxFiles,
      maxFileBytes: options.maxFileBytes ?? DEFAULT_INPUT_FILE_LIMITS.maxFileBytes,
      maxTotalFileBytes: options.maxTotalFileBytes ?? DEFAULT_INPUT_FILE_LIMITS.maxTotalFileBytes,
    };
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
      const inbound = normalizeInbound(body, tenantId, this.fileLimits);
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
      const inbound = normalizeInbound(body, tenantId, this.fileLimits);

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
  fileLimits: InputFileLimits = DEFAULT_INPUT_FILE_LIMITS,
): InboundMessage {
  const content = typeof body.content === 'string' ? body.content : '';
  const files = normalizeInputFiles(body.files, fileLimits);
  const images = Array.isArray(body.images)
    ? body.images.filter(isImage)
    : undefined;
  if (!content && !files?.length && !images?.length) {
    throw new Error('content, images, or files is required');
  }

  return {
    platform: 'http',
    channelId: typeof body.channelId === 'string' ? body.channelId : 'default',
    userId: typeof body.userId === 'string' ? body.userId : 'anonymous',
    displayName: typeof body.displayName === 'string' ? body.displayName : 'http-user',
    content,
    images,
    files,
    history: Array.isArray(body.history)
      ? body.history.filter(isChatMessage).map((m): LLMMessage => ({ role: m.role, content: m.content }))
      : undefined,
    tenantId,
    conversationId: typeof body.conversationId === 'string' ? body.conversationId : undefined,
  };
}

function normalizeInputFiles(
  value: unknown,
  limits: InputFileLimits,
): FileContent[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('files must be an array');
  if (value.length > limits.maxFiles) {
    throw new Error(`too many files: max ${limits.maxFiles}`);
  }

  const files: FileContent[] = [];
  let totalBytes = 0;
  for (let i = 0; i < value.length; i++) {
    const file = normalizeInputFile(value[i], i);
    const size = file.size ?? 0;
    if (size > limits.maxFileBytes) {
      throw new Error(`files[${i}] exceeds max file size ${limits.maxFileBytes} bytes`);
    }
    totalBytes += size;
    if (totalBytes > limits.maxTotalFileBytes) {
      throw new Error(`files exceed max total size ${limits.maxTotalFileBytes} bytes`);
    }
    files.push(file);
  }
  return files.length > 0 ? files : undefined;
}

function normalizeInputFile(value: unknown, index: number): FileContent {
  if (!value || typeof value !== 'object') {
    throw new Error(`files[${index}] must be an object`);
  }
  const raw = value as {
    name?: unknown;
    data?: unknown;
    mimeType?: unknown;
    mediaType?: unknown;
  };
  if (typeof raw.data !== 'string') {
    throw new Error(`files[${index}].data must be a base64 string`);
  }

  const parsed = normalizeBase64(raw.data, `files[${index}].data`);
  const mimeTypeInput = typeof raw.mimeType === 'string'
    ? raw.mimeType
    : typeof raw.mediaType === 'string'
      ? raw.mediaType
      : parsed.mimeType;
  const mimeType = normalizeMimeType(mimeTypeInput, index);
  const name = typeof raw.name === 'string' ? safeInputFilename(raw.name) : undefined;

  return {
    type: 'file',
    data: parsed.data,
    mimeType,
    ...(name ? { name } : {}),
    size: parsed.size,
  };
}

function normalizeBase64(data: string, field: string): { data: string; size: number; mimeType?: string } {
  const trimmed = data.trim();
  const dataUrl = /^data:([^;,]+);base64,(.+)$/i.exec(trimmed);
  const mimeType = dataUrl?.[1];
  const base64 = (dataUrl ? dataUrl[2] : trimmed).replace(/\s+/g, '');
  if (base64.length > 0 && (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1)) {
    throw new Error(`${field} is not valid base64`);
  }
  const buffer = Buffer.from(base64, 'base64');
  return { data: base64, size: buffer.length, ...(mimeType ? { mimeType } : {}) };
}

function normalizeMimeType(value: string | undefined, index: number): string {
  if (!value) throw new Error(`files[${index}].mimeType is required`);
  const mimeType = value.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)) {
    throw new Error(`files[${index}].mimeType is invalid`);
  }
  return mimeType;
}

function safeInputFilename(name: string): string | undefined {
  const base = name.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!base) return undefined;
  return base.slice(0, 200);
}

function isRateLimitError(err: unknown): boolean {
  return err instanceof Error && err.name === 'RateLimitError';
}

function isImage(x: unknown): x is { data: string; mimeType: string } {
  return !!x && typeof x === 'object'
    && typeof (x as { data?: unknown }).data === 'string'
    && typeof (x as { mimeType?: unknown }).mimeType === 'string';
}

function isChatMessage(x: unknown): x is { role: 'user' | 'assistant'; content: string } {
  return !!x && typeof x === 'object'
    && ((x as { role?: unknown }).role === 'user' || (x as { role?: unknown }).role === 'assistant')
    && typeof (x as { content?: unknown }).content === 'string';
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
<span class="tag" style="border-color:#e67e22;color:#e67e22">😈 critic</span>
<span class="tag" style="border-color:#e74c3c;color:#e74c3c">⚙️ researcher3</span>
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
const A={assistant:{av:'🤖',c:'#5865f2'},coder:{av:'💻',c:'#9b59b6'},researcher:{av:'🔍',c:'#2ecc71'},researcher2:{av:'🧠',c:'#e67e22'},researcher3:{av:'⚙️',c:'#e74c3c'},system:{av:'⚠️',c:'#95a5a6'}};
const TI={read:'📄',grep:'🔍',exec:'⚡',write:'✏️',edit:'✏️',delegate:'🤝',knowledge:'📚',speak:'💬',attention:'🚨',web_search:'🌐',join_meeting:'🚪',open_meeting:'📢',conclude_meeting:'✅',raise_hand:'🙋'};
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

let lastAgent='';let lastBubble=null;
function getBubble(name){
  if(name===lastAgent&&lastBubble)return lastBubble;
  lastAgent=name;
  const a=A[name]||A.system;
  const r=document.createElement('div');r.className='mrow';
  const av=document.createElement('div');av.className='av';av.style.background=a.c;av.textContent=a.av;
  const mc=document.createElement('div');mc.className='mc';
  const an=document.createElement('div');an.className='an';an.style.color=a.c;an.textContent=name;
  const tc=document.createElement('div');tc.className='tc';
  const bbl=document.createElement('div');bbl.className='abbl';
  mc.append(an,tc,bbl);r.append(av,mc);
  msgs.appendChild(r);scroll();
  lastBubble={el:r,tc:tc,bbl:bbl};
  return lastBubble;
}
function newBubble(name){lastAgent='';return getBubble(name);}

async function send(){
  const text=inp.value.trim();if(!text)return;
  inp.value='';addUser(text);
  lastAgent='';lastBubble=null;
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
      const lines=buf.split(String.fromCharCode(10)+String.fromCharCode(10));buf=lines.pop()||'';
      for(const line of lines){
        if(!line.startsWith('data: '))continue;
        try{
          const c=JSON.parse(line.slice(6));
          const ag=c.agent||'assistant';
          if(c.type==='text'){const o=getBubble(ag);if(o.bbl.textContent)o.bbl.textContent+=String.fromCharCode(10)+String.fromCharCode(10)+(c.text||'');else o.bbl.textContent=c.text||''}
          else if(c.type==='tool_call'){
            const o=getBubble(ag);
            const icon=TI[c.name]||'🔧';
            let det='';
            if(c.input){
              if(c.name==='speak'&&c.input.to){det=' → @'+(Array.isArray(c.input.to)?c.input.to.join(', @'):c.input.to);if(c.input.replyTo)det=' ← @'+c.input.replyTo+det;}
              else if(c.name==='attention')det=' ⚠️';
              else if(c.name==='read'&&c.input.path)det=' '+c.input.path;
              else if(c.name==='grep'&&c.input.pattern)det=' /'+c.input.pattern+'/';
              else if(c.name==='delegate'&&c.input.capability)det=' '+c.input.capability;
            }
            const cls=c.name==='attention'?'tch e':'tch c';
            const s=document.createElement('span');s.className=cls;s.textContent=icon+' '+c.name+(det||'');
            o.tc.appendChild(s);
          }
          else if(c.type==='tool_result'){const o=getBubble(ag);const s=document.createElement('span');s.className='tch '+(c.isError?'e':'r');s.textContent='✓ '+c.name;o.tc.appendChild(s)}
          else if(c.type==='error'){const o=newBubble(ag);o.bbl.textContent='[Error] '+(c.message||'')}
        }catch{}
      }
      scroll();
    }
  }catch(e){typ.remove();const o=newBubble('system');o.bbl.textContent='Error: '+e.message}
  btn.disabled=false;inp.disabled=false;inp.focus();
}
btn.addEventListener('click',send);
inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
inp.focus();
</script>
</div>
</body>
</html>`;
