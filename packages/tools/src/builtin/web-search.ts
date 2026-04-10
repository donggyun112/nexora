/**
 * web-search — 웹 검색 도구.
 *
 * 검색 backend를 외부에서 주입하는 형태 (API 키 분리).
 * 기본 구현 없음 — 사용자가 SearchBackend를 제공해야 함.
 */

import type { ToolDefinition, ToolResult } from '@nexora/contracts';
import { textResult, errorResult } from '@nexora/contracts';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchBackend {
  search(query: string, options?: { limit?: number }): Promise<SearchResult[]>;
}

export function createWebSearchTool(backend: SearchBackend): ToolDefinition {
  return {
    name: 'web_search',
    description:
      'Search the web for current information. Returns title, URL, and snippet for top results. ' +
      'Use for fact-checking, recent events, documentation lookup, or anything beyond your training data.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['query'],
    },
    execute: async (_id, input): Promise<ToolResult> => {
      const params = input as { query?: string; limit?: number };
      const query = (params.query ?? '').trim();
      if (!query) return errorResult('query is required');

      const limit = params.limit && params.limit > 0 ? Math.min(params.limit, 20) : 5;

      try {
        const results = await backend.search(query, { limit });
        if (results.length === 0) return textResult('No results found.');

        const lines = results.map((r, i) => {
          return `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`;
        });
        return textResult(`Search results for "${query}":\n\n${lines.join('\n\n')}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`web_search failed: ${msg}`);
      }
    },
  };
}
