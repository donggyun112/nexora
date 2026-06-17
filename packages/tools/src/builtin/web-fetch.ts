/**
 * web_fetch — Claude Code 스타일 web fetch.
 *
 * 동작:
 *   1. 임의 URL을 받아 가져온다 (HTTP → HTTPS 자동 승격).
 *   2. HTML/텍스트 응답을 가독성 있는 일반 텍스트로 정리한다.
 *   3. 선택적 summarizer(LLM)에게 `prompt`와 함께 전달해 그 응답을 반환한다.
 *      summarizer가 없으면 정리된 텍스트를 max_chars로 잘라 그대로 반환한다.
 *   4. (url, prompt) 키로 15분 in-memory 캐시.
 *
 * web-search.ts 패턴과 동일하게 외부 의존성(summarizer, fetch)을 주입한다.
 */

import type { ToolDefinition, ToolResult, ToolContext } from '@dongkseo/contracts';
import { textResult, errorResult } from '@dongkseo/contracts';

export interface WebFetchSummarizer {
  /**
   * Apply `prompt` to `content` and return the model's response.
   * Implementers typically wrap an LLMProvider.complete() call.
   */
  summarize(
    content: string,
    prompt: string,
    options?: { signal?: AbortSignal },
  ): Promise<string>;
}

export interface WebFetchToolOptions {
  /** Optional LLM-based summarizer. If omitted, returns truncated raw text. */
  summarizer?: WebFetchSummarizer;
  /** Cache TTL in ms. Default: 15 minutes (Claude Code parity). */
  cacheTtlMs?: number;
  /** Hard cap on bytes downloaded per request. Default: 5 MiB. */
  maxBytes?: number;
  /** Per-request fetch timeout in ms. Default: 30s. */
  fetchTimeoutMs?: number;
  /** Override fetch (tests). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Override clock (tests). Default: Date.now. */
  now?: () => number;
}

interface CacheEntry {
  text: string;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULT_CHARS = 30_000;

const ALLOWED_CONTENT_PREFIXES = [
  'text/',
  'application/json',
  'application/xml',
  'application/xhtml',
  'application/ld+json',
];

export function createWebFetchTool(options: WebFetchToolOptions = {}): ToolDefinition {
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.fetchTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  return {
    name: 'web_fetch',
    description:
      'Fetch a URL and return its readable content. ' +
      'HTTP URLs are auto-upgraded to HTTPS. If a `prompt` is given and a summarizer is configured, ' +
      'the page text is processed by an LLM and that response is returned; otherwise the cleaned ' +
      'text is returned (truncated). Results are cached for 15 minutes per (url, prompt).',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Fully-formed URL to fetch (http:// is auto-upgraded to https://).',
        },
        prompt: {
          type: 'string',
          description:
            'What to extract or how to summarize the content. If no summarizer is configured, ' +
            'this is ignored and the raw cleaned text is returned.',
        },
        max_chars: {
          type: 'number',
          description: 'Max characters in the result. Default 30000, max 100000.',
        },
      },
      required: ['url'],
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    visibility: 'detail',
    execute: async (
      _callId: string,
      input: unknown,
      ctx: ToolContext,
    ): Promise<ToolResult> => {
      const params = (input ?? {}) as {
        url?: unknown;
        prompt?: unknown;
        max_chars?: unknown;
      };

      const rawUrl = typeof params.url === 'string' ? params.url.trim() : '';
      if (!rawUrl) return errorResult('url is required');

      const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';

      const maxCharsRaw = typeof params.max_chars === 'number' ? params.max_chars : undefined;
      const maxChars = clamp(
        Number.isFinite(maxCharsRaw) ? (maxCharsRaw as number) : DEFAULT_MAX_RESULT_CHARS,
        500,
        100_000,
      );

      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return errorResult(`Invalid URL: ${rawUrl}`);
      }

      if (url.protocol === 'http:') {
        url.protocol = 'https:';
      } else if (url.protocol !== 'https:') {
        return errorResult(`Unsupported URL scheme: ${url.protocol}`);
      }

      const cacheKey = `${url.toString()}::${prompt}`;
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > now()) {
        return textResult(cached.text);
      }
      if (cached) cache.delete(cacheKey);

      let fetched: FetchedContent;
      try {
        fetched = await fetchPage(url.toString(), {
          fetchImpl,
          maxBytes,
          timeoutMs,
          signal: ctx.signal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`web_fetch failed: ${msg}`);
      }

      const cleaned = cleanContent(fetched.body, fetched.contentType);

      let resultText: string;
      if (options.summarizer && prompt) {
        try {
          const summary = await options.summarizer.summarize(cleaned, prompt, {
            signal: ctx.signal,
          });
          resultText = formatSummaryResult({
            url: fetched.finalUrl,
            contentType: fetched.contentType,
            summary,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.warn?.(`web_fetch summarizer failed, falling back to raw: ${msg}`);
          resultText = formatRawResult({
            url: fetched.finalUrl,
            contentType: fetched.contentType,
            body: cleaned,
            maxChars,
          });
        }
      } else {
        resultText = formatRawResult({
          url: fetched.finalUrl,
          contentType: fetched.contentType,
          body: cleaned,
          maxChars,
        });
      }

      cache.set(cacheKey, { text: resultText, expiresAt: now() + ttl });
      return textResult(resultText);
    },
  };
}

// ── internals ──────────────────────────────────────────────────────────────

interface FetchedContent {
  body: string;
  contentType: string;
  finalUrl: string;
}

interface FetchOptions {
  fetchImpl: typeof fetch;
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

async function fetchPage(url: string, opts: FetchOptions): Promise<FetchedContent> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), opts.timeoutMs);

  const onParentAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort(opts.signal.reason);
    else opts.signal.addEventListener('abort', onParentAbort, { once: true });
  }

  try {
    const res = await opts.fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Nexora-WebFetch/1.0',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.9,application/json;q=0.9,*/*;q=0.5',
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const contentType = (res.headers.get('content-type') ?? 'text/plain').toLowerCase();
    if (!ALLOWED_CONTENT_PREFIXES.some((p) => contentType.startsWith(p))) {
      throw new Error(`Unsupported content-type: ${contentType}`);
    }

    const buf = await readWithLimit(res, opts.maxBytes);
    const text = decodeBody(buf, contentType);
    return { body: text, contentType, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onParentAbort);
  }
}

async function readWithLimit(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      return new Uint8Array(ab, 0, maxBytes);
    }
    return new Uint8Array(ab);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        const room = maxBytes - (total - value.byteLength);
        if (room > 0) chunks.push(value.subarray(0, room));
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
}

function decodeBody(buf: Uint8Array, contentType: string): string {
  const charsetMatch = /charset=([^;]+)/i.exec(contentType);
  const charset = (charsetMatch?.[1] ?? 'utf-8').trim().toLowerCase();
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
}

function cleanContent(raw: string, contentType: string): string {
  if (contentType.startsWith('text/html') || contentType.startsWith('application/xhtml')) {
    return htmlToText(raw);
  }
  return raw.replace(/\r\n/g, '\n').trim();
}

function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<\/?(p|div|section|article|header|footer|li|tr|br|hr|h[1-6])\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/\n[ \t]+/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)));
}

function formatSummaryResult(args: {
  url: string;
  contentType: string;
  summary: string;
}): string {
  return [
    `URL: ${args.url}`,
    `Content-Type: ${args.contentType}`,
    '',
    args.summary.trim() || '(empty)',
  ].join('\n');
}

function formatRawResult(args: {
  url: string;
  contentType: string;
  body: string;
  maxChars: number;
}): string {
  const truncated = args.body.length > args.maxChars;
  const body = truncated ? args.body.slice(0, args.maxChars) : args.body;
  const lines = [
    `URL: ${args.url}`,
    `Content-Type: ${args.contentType}`,
  ];
  if (truncated) lines.push(`Truncated: yes (${args.maxChars} of ${args.body.length} chars)`);
  lines.push('', body || '(empty)');
  return lines.join('\n');
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}
