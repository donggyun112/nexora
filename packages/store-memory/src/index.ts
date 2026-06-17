/**
 * @dongkseo/store-memory — Associative Memory Graph.
 *
 * Optional package. Adds N:M key-value graph memory with:
 * - 2-hop associative search (Newton → apple → fruit → strawberry)
 * - Depth reinforcement (frequently recalled → stronger)
 * - Time decay (shallow memories fade, deep memories persist)
 * - Supersede chains (versioning, not overwrite)
 * - Duplicate detection (cosine ≥ 0.90 → supersede)
 * - Key merging (cosine ≥ 0.85 → reuse concept)
 *
 * Usage:
 * ```typescript
 * import { MemoryGraph } from '@dongkseo/store-memory';
 *
 * const graph = new MemoryGraph({
 *   embedding: { embed: async (text) => openai.embeddings.create({ input: text, model: 'text-embedding-3-small' }).then(r => r.data[0].embedding) },
 * });
 *
 * await graph.remember("User prefers TypeScript", ["programming", "preference"]);
 * const results = await graph.recall("What language does the user like?");
 * ```
 */

export { MemoryGraph } from './memory-graph.js';
export type { MemoryGraphOptions } from './memory-graph.js';

export { cosineSim, batchCosineSim } from './vector.js';

export { createOpenAIEmbedding, createOllamaEmbedding } from './embedding-providers.js';
export type { OpenAIEmbeddingOptions, OllamaEmbeddingOptions } from './embedding-providers.js';

export type {
  Memory,
  MemoryKey,
  MemoryKeyLink,
  GraphData,
  RecallResult,
  EmbeddingProvider,
  KeyType,
} from './types.js';
