/**
 * Brave Image Search backend for image_search tool.
 */

import type { ImageSearchBackend, ImageSearchResult } from './image-search.js';

export interface BraveImageSearchOptions {
  apiKey: string;
}

interface BraveImageSearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    source?: string;
    thumbnail?: {
      src?: string;
      width?: number;
      height?: number;
    };
    properties?: {
      url?: string;
      width?: number;
      height?: number;
    };
    meta_url?: {
      hostname?: string;
      netloc?: string;
    };
    confidence?: string;
  }>;
}

export function createBraveImageBackend(options: BraveImageSearchOptions): ImageSearchBackend {
  return {
    async searchImages(query, opts): Promise<ImageSearchResult[]> {
      const limit = Math.min(Math.max(opts?.limit ?? 8, 1), 20);
      const params = new URLSearchParams({
        q: query,
        count: String(limit),
        country: opts?.country ?? 'US',
        search_lang: opts?.searchLang ?? 'en',
        safesearch: opts?.safesearch ?? 'strict',
      });
      const url = `https://api.search.brave.com/res/v1/images/search?${params.toString()}`;
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': options.apiKey,
        },
      });
      if (!res.ok) {
        throw new Error(`Brave Image Search API error: ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as BraveImageSearchResponse;
      const results = data.results ?? [];
      return results
        .map((r): ImageSearchResult => ({
          title: r.title ?? '',
          pageUrl: r.url ?? '',
          imageUrl: r.properties?.url ?? '',
          thumbnailUrl: r.thumbnail?.src ?? r.properties?.url ?? '',
          source: r.source ?? r.meta_url?.hostname ?? r.meta_url?.netloc ?? '',
          ...(typeof r.properties?.width === 'number' ? { width: r.properties.width } : {}),
          ...(typeof r.properties?.height === 'number' ? { height: r.properties.height } : {}),
          ...(typeof r.thumbnail?.width === 'number' ? { thumbnailWidth: r.thumbnail.width } : {}),
          ...(typeof r.thumbnail?.height === 'number' ? { thumbnailHeight: r.thumbnail.height } : {}),
          ...(r.confidence ? { confidence: r.confidence } : {}),
        }))
        .filter((r) => r.imageUrl || r.thumbnailUrl)
        .slice(0, limit);
    },
  };
}
