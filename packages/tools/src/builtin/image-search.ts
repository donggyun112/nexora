/**
 * image-search — 이미지 레퍼런스 검색 도구.
 *
 * 검색 backend를 외부에서 주입하는 형태 (API 키 분리).
 * 결과는 이미지 생성 전 moodboard/reference 후보로 쓰기 쉬운 compact JSON으로 반환한다.
 */

import type { ToolDefinition, ToolResult } from '@nexora/contracts';
import { textResult, errorResult } from '@nexora/contracts';

export interface ImageSearchResult {
  title: string;
  pageUrl: string;
  imageUrl: string;
  thumbnailUrl: string;
  source: string;
  width?: number;
  height?: number;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  confidence?: string;
}

export interface ImageSearchBackend {
  searchImages(
    query: string,
    options?: {
      limit?: number;
      safesearch?: 'strict' | 'off';
      country?: string;
      searchLang?: string;
    },
  ): Promise<ImageSearchResult[]>;
}

export function createImageSearchTool(backend: ImageSearchBackend): ToolDefinition {
  return {
    name: 'image_search',
    description:
      'Search the web for image references and visual directions. Returns compact JSON with title, page URL, ' +
      'source, thumbnail URL, and original image URL. Use before image generation to build moodboard/reference options. ' +
      'References are for visual inspiration only; do not copy a specific copyrighted image exactly.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Image search query' },
        limit: { type: 'number', description: 'Max results to return to the agent (default 8, max 20)' },
        safesearch: {
          type: 'string',
          enum: ['strict', 'off'],
          description: 'Image SafeSearch mode (default strict)',
        },
        country: { type: 'string', description: '2-letter country code or ALL (default US)' },
        search_lang: { type: 'string', description: 'Search language code (default en)' },
      },
      required: ['query'],
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    maxResultSizeChars: 12_000,
    execute: async (_id, input): Promise<ToolResult> => {
      const params = input as {
        query?: string;
        limit?: number;
        safesearch?: 'strict' | 'off';
        country?: string;
        search_lang?: string;
      };
      const query = (params.query ?? '').trim();
      if (!query) return errorResult('query is required');

      const limit = params.limit && params.limit > 0 ? Math.min(params.limit, 20) : 8;
      const safesearch = params.safesearch === 'off' ? 'off' : 'strict';
      const country = normalizeCountry(params.country);
      const searchLang = normalizeSearchLang(params.search_lang);

      try {
        const results = await backend.searchImages(query, {
          limit,
          safesearch,
          country,
          searchLang,
        });
        if (results.length === 0) return textResult('No image results found.');

        return textResult(
          JSON.stringify(
            {
              query,
              safesearch,
              country,
              search_lang: searchLang,
              results,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`image_search failed: ${msg}`);
      }
    },
  };
}

function normalizeCountry(value?: string): string {
  const v = (value ?? 'US').trim().toUpperCase();
  if (v === 'ALL') return v;
  return /^[A-Z]{2}$/.test(v) ? v : 'US';
}

function normalizeSearchLang(value?: string): string {
  const v = (value ?? 'en').trim().toLowerCase();
  return /^[a-z]{2,8}(-[a-z]{2,8})?$/.test(v) ? v : 'en';
}
