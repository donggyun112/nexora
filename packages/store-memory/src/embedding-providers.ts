/**
 * Built-in embedding providers — OpenAI API + Ollama (local model).
 *
 * Both implement EmbeddingProvider interface.
 * Import only what you need — no forced dependency on either.
 *
 * Usage:
 * ```typescript
 * // Cloud: OpenAI
 * const embedding = createOpenAIEmbedding({ apiKey: process.env.OPENAI_API_KEY });
 *
 * // Local: Ollama (free, no API key)
 * const embedding = createOllamaEmbedding({ model: 'nomic-embed-text' });
 *
 * const graph = new MemoryGraph({ embedding });
 * ```
 */

import type { EmbeddingProvider } from './types.js';

// ─── OpenAI Embedding ──────────────────────────────────────────────────

export interface OpenAIEmbeddingOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
}

/**
 * OpenAI text-embedding-3-small (1536 dims, $0.02/M tokens).
 * Also works with any OpenAI-compatible API (Azure, Together, etc.).
 */
export function createOpenAIEmbedding(options: OpenAIEmbeddingOptions = {}): EmbeddingProvider {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
  const model = options.model ?? 'text-embedding-3-small';
  const baseURL = options.baseURL ?? 'https://api.openai.com/v1';

  async function embedSingle(text: string): Promise<number[]> {
    const response = await fetch(`${baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ input: text, model }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI embedding failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
    };
    return data.data[0].embedding;
  }

  async function embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ input: texts, model }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI embedding failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    return data.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
  }

  return { embed: embedSingle, embedBatch };
}

// ─── Ollama Embedding (Local) ──────────────────────────────────────────

export interface OllamaEmbeddingOptions {
  /** Model name. Default: 'nomic-embed-text' */
  model?: string;
  /** Ollama server URL. Default: 'http://localhost:11434' */
  baseURL?: string;
}

/**
 * Ollama local embedding — free, no API key, runs on your machine.
 *
 * Recommended models:
 * - nomic-embed-text (768 dims, fast, good quality)
 * - mxbai-embed-large (1024 dims, better quality)
 * - all-minilm (384 dims, smallest/fastest)
 *
 * Install: ollama pull nomic-embed-text
 */
export function createOllamaEmbedding(options: OllamaEmbeddingOptions = {}): EmbeddingProvider {
  const model = options.model ?? 'nomic-embed-text';
  const baseURL = options.baseURL ?? 'http://localhost:11434';

  async function embedSingle(text: string): Promise<number[]> {
    const response = await fetch(`${baseURL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embedding failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { embeddings: number[][] };
    return data.embeddings[0];
  }

  async function embedBatch(texts: string[]): Promise<number[][]> {
    // Ollama supports batch via array input
    const response = await fetch(`${baseURL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embedding failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { embeddings: number[][] };
    return data.embeddings;
  }

  return { embed: embedSingle, embedBatch };
}
