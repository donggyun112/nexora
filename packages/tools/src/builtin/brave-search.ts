/**
 * Brave Search backend for web_search tool.
 */

import type { SearchBackend, SearchResult } from './web-search.js';

export interface BraveSearchOptions {
  apiKey: string;
}

export function createBraveBackend(options: BraveSearchOptions): SearchBackend {
  return {
    async search(query: string, opts?: { limit?: number }): Promise<SearchResult[]> {
      const limit = opts?.limit ?? 5;
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': options.apiKey,
        },
      });
      if (!res.ok) {
        throw new Error(`Brave Search API error: ${res.status} ${res.statusText}`);
      }
      const data = await res.json() as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
      };
      const results = data.web?.results ?? [];
      return results.map(r => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.description ?? '',
      }));
    },
  };
}
