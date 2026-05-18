import { describe, it, expect } from 'vitest';
import { createWebFetchTool } from '../builtin/web-fetch.js';
import type { ToolContext } from '@nexora/contracts';

function makeContext(): ToolContext {
  return {
    tenantId: 'tenant-1',
    workdir: '/tmp',
    secrets: { get: async () => undefined },
    logger: { info: () => {}, warn: () => {}, err: () => {} },
  };
}

interface MockFetchPlan {
  url?: string;
  status?: number;
  statusText?: string;
  contentType?: string;
  body?: string;
  /** If set, the mock fetch will record calls and throw if invoked more than `maxCalls` times. */
  maxCalls?: number;
}

function makeFetch(plan: MockFetchPlan) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const requested = typeof input === 'string' ? input : input.toString();
    calls.push(requested);
    if (plan.maxCalls != null && calls.length > plan.maxCalls) {
      throw new Error(`mock fetch called too many times: ${calls.length}`);
    }
    const status = plan.status ?? 200;
    const statusText = plan.statusText ?? 'OK';
    const headers = new Headers({ 'content-type': plan.contentType ?? 'text/plain' });
    return new Response(plan.body ?? '', {
      status,
      statusText,
      headers,
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('web_fetch tool', () => {
  it('errors on missing url', async () => {
    const tool = createWebFetchTool();
    const result = await tool.execute('1', {}, makeContext());
    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toMatch(/url is required/);
  });

  it('errors on invalid url', async () => {
    const tool = createWebFetchTool();
    const result = await tool.execute('1', { url: 'not a url' }, makeContext());
    expect(result.type).toBe('error');
  });

  it('rejects non-http(s) schemes', async () => {
    const tool = createWebFetchTool();
    const result = await tool.execute(
      '1',
      { url: 'file:///etc/passwd' },
      makeContext(),
    );
    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toMatch(/scheme/i);
  });

  it('auto-upgrades http to https', async () => {
    const { fetchImpl, calls } = makeFetch({ body: 'hello world' });
    const tool = createWebFetchTool({ fetchImpl });
    const result = await tool.execute(
      '1',
      { url: 'http://example.com/page' },
      makeContext(),
    );
    expect(result.type).toBe('text');
    expect(calls[0]).toBe('https://example.com/page');
  });

  it('returns cleaned text when no summarizer is configured', async () => {
    const html =
      '<html><head><style>.x{}</style></head><body><h1>Title</h1><p>Hello <b>world</b>!</p></body></html>';
    const { fetchImpl } = makeFetch({ contentType: 'text/html; charset=utf-8', body: html });
    const tool = createWebFetchTool({ fetchImpl });
    const result = await tool.execute(
      '1',
      { url: 'https://example.com/' },
      makeContext(),
    );
    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('Title');
      expect(result.text).toContain('Hello world!');
      expect(result.text).not.toContain('<style>');
      expect(result.text).not.toContain('<h1>');
    }
  });

  it('uses summarizer when prompt is provided', async () => {
    const { fetchImpl } = makeFetch({ body: 'raw page content' });
    let seenPrompt = '';
    let seenContent = '';
    const tool = createWebFetchTool({
      fetchImpl,
      summarizer: {
        summarize: async (content, prompt) => {
          seenContent = content;
          seenPrompt = prompt;
          return 'SUMMARY OUTPUT';
        },
      },
    });
    const result = await tool.execute(
      '1',
      { url: 'https://example.com/x', prompt: 'extract title' },
      makeContext(),
    );
    expect(result.type).toBe('text');
    if (result.type === 'text') expect(result.text).toContain('SUMMARY OUTPUT');
    expect(seenPrompt).toBe('extract title');
    expect(seenContent).toContain('raw page content');
  });

  it('falls back to raw text when summarizer throws', async () => {
    const { fetchImpl } = makeFetch({ body: 'raw page content' });
    const tool = createWebFetchTool({
      fetchImpl,
      summarizer: {
        summarize: async () => {
          throw new Error('summarizer down');
        },
      },
    });
    const result = await tool.execute(
      '1',
      { url: 'https://example.com/x', prompt: 'summarize' },
      makeContext(),
    );
    expect(result.type).toBe('text');
    if (result.type === 'text') expect(result.text).toContain('raw page content');
  });

  it('caches results for 15 minutes per (url, prompt)', async () => {
    const { fetchImpl, calls } = makeFetch({ body: 'cached body', maxCalls: 1 });
    let nowValue = 1_000_000;
    const tool = createWebFetchTool({ fetchImpl, now: () => nowValue });

    const r1 = await tool.execute('1', { url: 'https://example.com/c' }, makeContext());
    expect(r1.type).toBe('text');
    nowValue += 10 * 60 * 1000;
    const r2 = await tool.execute('2', { url: 'https://example.com/c' }, makeContext());
    expect(r2.type).toBe('text');
    expect(calls.length).toBe(1);

    if (r1.type === 'text' && r2.type === 'text') {
      expect(r2.text).toBe(r1.text);
    }
  });

  it('refetches after cache expiry', async () => {
    const { fetchImpl, calls } = makeFetch({ body: 'fresh body' });
    let nowValue = 1_000_000;
    const tool = createWebFetchTool({ fetchImpl, now: () => nowValue });

    await tool.execute('1', { url: 'https://example.com/c' }, makeContext());
    nowValue += 16 * 60 * 1000;
    await tool.execute('2', { url: 'https://example.com/c' }, makeContext());
    expect(calls.length).toBe(2);
  });

  it('separate cache entries for distinct prompts', async () => {
    const { fetchImpl, calls } = makeFetch({ body: 'body' });
    const tool = createWebFetchTool({ fetchImpl });

    await tool.execute('1', { url: 'https://example.com/c', prompt: 'a' }, makeContext());
    await tool.execute('2', { url: 'https://example.com/c', prompt: 'b' }, makeContext());
    expect(calls.length).toBe(2);
  });

  it('reports errors on non-2xx', async () => {
    const { fetchImpl } = makeFetch({ status: 500, statusText: 'Server Error', body: '' });
    const tool = createWebFetchTool({ fetchImpl });
    const result = await tool.execute(
      '1',
      { url: 'https://example.com/' },
      makeContext(),
    );
    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toMatch(/HTTP 500/);
  });

  it('rejects unsupported content types', async () => {
    const { fetchImpl } = makeFetch({
      contentType: 'application/octet-stream',
      body: '\x00\x01\x02',
    });
    const tool = createWebFetchTool({ fetchImpl });
    const result = await tool.execute(
      '1',
      { url: 'https://example.com/' },
      makeContext(),
    );
    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toMatch(/content-type/i);
  });

  it('truncates result text by max_chars', async () => {
    const body = 'a'.repeat(5000);
    const { fetchImpl } = makeFetch({ body });
    const tool = createWebFetchTool({ fetchImpl });
    const result = await tool.execute(
      '1',
      { url: 'https://example.com/', max_chars: 1000 },
      makeContext(),
    );
    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('Truncated: yes');
      const bodyMatches = result.text.match(/a{500,}/);
      expect(bodyMatches?.[0].length ?? 0).toBeLessThanOrEqual(1000);
    }
  });
});
