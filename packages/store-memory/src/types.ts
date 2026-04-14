/**
 * Associative Memory Graph — types.
 *
 * N:M bipartite graph: Keys (concepts) ↔ Memories (facts).
 * Based on super-memory reference implementation.
 */

export type KeyType = 'concept' | 'name' | 'proper_noun';

export interface MemoryKey {
  id: string;
  concept: string;
  embedding: number[];
  keyType: KeyType;
}

export interface Memory {
  id: string;
  content: string;
  embedding: number[];
  depth: number;
  createdAt: number;
  updatedAt: number;
  /** ID of the memory this supersedes (version chain) */
  supersedes: string | null;
  /** Explicit links to other memories */
  links: string[];
  /** Metadata */
  metadata?: Record<string, unknown>;
}

export interface MemoryKeyLink {
  keyId: string;
  memoryId: string;
}

export interface GraphData {
  keys: MemoryKey[];
  memories: Memory[];
  links: MemoryKeyLink[];
}

export interface RecallResult {
  memoryId: string;
  content: string;
  score: number;
  depth: number;
  hop: 1 | 2;
  matchedVia: string[];
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}
