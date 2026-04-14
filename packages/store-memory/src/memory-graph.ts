/**
 * MemoryGraph — N:M associative memory with 2-hop recall.
 *
 * Core algorithm from super-memory reference:
 * - Dual-path retrieval (key-based + content-based)
 * - 2-hop associative search via shared keys
 * - Depth reinforcement on recall (+0.05 per access)
 * - Time decay weighted by depth (deep memories decay slower)
 * - Supersede chains (versioning, not overwrite)
 * - Key merging (cosine ≥ 0.85 → reuse existing concept key)
 * - Duplicate detection (cosine ≥ 0.90 → supersede instead of create)
 */

import { cosineSim } from './vector.js';
import type {
  Memory,
  MemoryKey,
  MemoryKeyLink,
  GraphData,
  RecallResult,
  EmbeddingProvider,
  KeyType,
} from './types.js';

// ─── Constants (from super-memory) ─────────────────────────────────────

const KEY_MERGE_THRESHOLD = 0.85;
const MEMORY_DEDUP_THRESHOLD = 0.90;
const KEY_AUTO_LINK_THRESHOLD = 0.50;
const KEY_RECALL_THRESHOLD = 0.28;
const CONTENT_RECALL_THRESHOLD = 0.28;
const DEPTH_INCREMENT = 0.05;
const DEPTH_MAX = 1.0;
const DEPTH_DEEP_THRESHOLD = 0.7;
const HOP_DECAY = 0.5;
const TIME_HALF_LIFE = 30 * 24 * 60 * 60; // 30 days in seconds

let nextId = 0;
function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++nextId}`;
}

// ─── MemoryGraph ───────────────────────────────────────────────────────

export interface MemoryGraphOptions {
  embedding: EmbeddingProvider;
  /** Pre-loaded graph data (for persistence restore) */
  data?: GraphData;
}

export class MemoryGraph {
  private readonly embedding: EmbeddingProvider;
  private keys: MemoryKey[] = [];
  private memories: Memory[] = [];
  private links: MemoryKeyLink[] = [];
  /** Tracks which memories are superseded (hidden from recall) */
  private supersededBy = new Map<string, string>();

  constructor(options: MemoryGraphOptions) {
    this.embedding = options.embedding;
    if (options.data) {
      this.keys = [...options.data.keys];
      this.memories = [...options.data.memories];
      this.links = [...options.data.links];
      this.rebuildSupersededIndex();
    }
  }

  // ─── Remember ──────────────────────────────────────────────────────

  /**
   * Store a new memory with associated keys.
   * Returns the memory ID (or superseded duplicate's ID).
   */
  async remember(
    content: string,
    keysConcepts: string[],
    options?: {
      keyTypes?: Record<string, KeyType>;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ id: string; deduplicated: boolean }> {
    const contentEmbedding = await this.embedding.embed(content);

    // Duplicate detection: if very similar memory exists, supersede it
    const duplicate = this.findDuplicate(contentEmbedding);
    if (duplicate) {
      this.supersedeMemory(duplicate.id, content, contentEmbedding, options?.metadata);
      return { id: duplicate.id, deduplicated: true };
    }

    // Create memory
    const memory: Memory = {
      id: genId('mem'),
      content,
      embedding: contentEmbedding,
      depth: 0.0,
      createdAt: Date.now() / 1000,
      updatedAt: Date.now() / 1000,
      supersedes: null,
      links: [],
      metadata: options?.metadata,
    };
    this.memories.push(memory);

    // Resolve or create keys
    for (const concept of keysConcepts) {
      const keyType = options?.keyTypes?.[concept] ?? 'concept';
      const key = await this.resolveOrCreateKey(concept, keyType);
      this.links.push({ keyId: key.id, memoryId: memory.id });
    }

    // Auto-link: find semantically related existing keys
    for (const key of this.keys) {
      if (this.links.some(l => l.keyId === key.id && l.memoryId === memory.id)) continue;
      const sim = cosineSim(contentEmbedding, key.embedding);
      if (sim >= KEY_AUTO_LINK_THRESHOLD) {
        this.links.push({ keyId: key.id, memoryId: memory.id });
      }
    }

    return { id: memory.id, deduplicated: false };
  }

  // ─── Recall (2-hop search) ─────────────────────────────────────────

  /**
   * Recall memories relevant to a query.
   * Dual-path: key matching + content matching + 2-hop association.
   */
  async recall(query: string, limit = 10): Promise<RecallResult[]> {
    const queryEmbedding = await this.embedding.embed(query);
    const scores = new Map<string, { score: number; hop: 1 | 2; via: string[] }>();
    const now = Date.now() / 1000;

    // Path A: Key-based matching
    const matchedKeys = this.matchKeys(queryEmbedding);
    for (const { key, similarity } of matchedKeys) {
      const idf = this.keyIdf(key.id);
      const linkedMemories = this.getMemoriesForKey(key.id);

      for (const mem of linkedMemories) {
        if (this.supersededBy.has(mem.id)) continue;
        const depthFactor = 0.9 + mem.depth * 0.1;
        const timeFactor = this.timeFactor(mem, now);
        const score = similarity * idf * depthFactor * timeFactor;

        const existing = scores.get(mem.id);
        if (existing) {
          existing.score += score;
          existing.via.push(key.concept);
        } else {
          scores.set(mem.id, { score, hop: 1, via: [key.concept] });
        }
      }
    }

    // Path B: Content-based direct matching
    for (const mem of this.memories) {
      if (this.supersededBy.has(mem.id)) continue;
      const contentSim = cosineSim(queryEmbedding, mem.embedding);
      if (contentSim < CONTENT_RECALL_THRESHOLD) continue;

      const depthFactor = 0.9 + mem.depth * 0.1;
      const timeFactor = this.timeFactor(mem, now);
      const contentScore = contentSim * depthFactor * timeFactor * 0.8;

      const existing = scores.get(mem.id);
      if (existing) {
        existing.score += contentScore * 0.2; // boost, not replace
      } else {
        scores.set(mem.id, { score: contentScore, hop: 1, via: ['(content)'] });
      }
    }

    // 2-hop: follow keys of 1-hop results to find associated memories
    const hop1Entries = [...scores.entries()];
    for (const [memId, { score: hop1Score }] of hop1Entries) {
      const keysForMem = this.getKeysForMemory(memId);
      for (const key of keysForMem) {
        const idf = this.keyIdf(key.id);
        const linkedMemories = this.getMemoriesForKey(key.id);
        for (const otherMem of linkedMemories) {
          if (otherMem.id === memId) continue;
          if (this.supersededBy.has(otherMem.id)) continue;
          const hop2Score = hop1Score * HOP_DECAY * idf;

          const existing = scores.get(otherMem.id);
          if (existing) {
            existing.score += hop2Score;
            if (!existing.via.includes(`${key.concept}(via)`)) {
              existing.via.push(`${key.concept}(via)`);
            }
          } else {
            scores.set(otherMem.id, { score: hop2Score, hop: 2, via: [`${key.concept}(via)`] });
          }
        }
      }

      // Explicit links
      const mem = this.memories.find(m => m.id === memId);
      if (mem) {
        for (const linkedId of mem.links) {
          if (this.supersededBy.has(linkedId)) continue;
          const linkScore = hop1Score * HOP_DECAY;
          const existing = scores.get(linkedId);
          if (existing) {
            existing.score += linkScore;
          } else {
            scores.set(linkedId, { score: linkScore, hop: 2, via: ['(linked)'] });
          }
        }
      }
    }

    // Sort and return top K
    const results: RecallResult[] = [...scores.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit)
      .map(([memId, info]) => {
        const mem = this.memories.find(m => m.id === memId)!;
        return {
          memoryId: memId,
          content: mem.content,
          score: Math.round(info.score * 1000) / 1000,
          depth: mem.depth,
          hop: info.hop,
          matchedVia: info.via,
        };
      });

    // Reinforce depth for recalled memories
    for (const result of results) {
      const mem = this.memories.find(m => m.id === result.memoryId);
      if (mem) {
        mem.depth = Math.min(mem.depth + DEPTH_INCREMENT, DEPTH_MAX);
      }
    }

    return results;
  }

  // ─── Supersede ─────────────────────────────────────────────────────

  private supersedeMemory(
    oldId: string,
    newContent: string,
    newEmbedding: number[],
    metadata?: Record<string, unknown>,
  ): void {
    const oldMem = this.memories.find(m => m.id === oldId);
    if (!oldMem) return;

    // Reduce old memory depth
    if (oldMem.depth >= DEPTH_DEEP_THRESHOLD) {
      oldMem.depth *= 0.8;
    } else {
      oldMem.depth *= 0.3;
    }

    // Clean up supersede chain (max length 1 — delete grandparent)
    if (oldMem.supersedes) {
      const grandparent = this.memories.find(m => m.id === oldMem.supersedes);
      if (grandparent) {
        this.memories = this.memories.filter(m => m.id !== grandparent.id);
        this.links = this.links.filter(l => l.memoryId !== grandparent.id);
      }
    }

    // Create new version
    const newMem: Memory = {
      id: genId('mem'),
      content: newContent,
      embedding: newEmbedding,
      depth: 0.0,
      createdAt: Date.now() / 1000,
      updatedAt: Date.now() / 1000,
      supersedes: oldId,
      links: [...oldMem.links],
      metadata,
    };
    this.memories.push(newMem);

    // Copy key links from old to new
    const oldLinks = this.links.filter(l => l.memoryId === oldId);
    for (const link of oldLinks) {
      this.links.push({ keyId: link.keyId, memoryId: newMem.id });
    }

    // Mark old as superseded
    this.supersededBy.set(oldId, newMem.id);
  }

  // ─── Key resolution ────────────────────────────────────────────────

  private async resolveOrCreateKey(concept: string, keyType: KeyType): Promise<MemoryKey> {
    // Name/proper_noun: exact match only
    if (keyType === 'name' || keyType === 'proper_noun') {
      const existing = this.keys.find(k => k.concept === concept && k.keyType === keyType);
      if (existing) return existing;
    } else {
      // Concept: check embedding similarity for merge
      const embedding = await this.embedding.embed(concept);
      for (const key of this.keys) {
        if (key.keyType !== 'concept') continue;
        const sim = cosineSim(embedding, key.embedding);
        if (sim >= KEY_MERGE_THRESHOLD) return key;
      }

      const newKey: MemoryKey = {
        id: genId('key'),
        concept,
        embedding,
        keyType,
      };
      this.keys.push(newKey);
      return newKey;
    }

    // Create new name/proper_noun key
    const embedding = await this.embedding.embed(concept);
    const newKey: MemoryKey = {
      id: genId('key'),
      concept,
      embedding,
      keyType,
    };
    this.keys.push(newKey);
    return newKey;
  }

  // ─── Scoring helpers ───────────────────────────────────────────────

  private matchKeys(queryEmbedding: number[]): Array<{ key: MemoryKey; similarity: number }> {
    const matches: Array<{ key: MemoryKey; similarity: number }> = [];
    for (const key of this.keys) {
      const sim = cosineSim(queryEmbedding, key.embedding);
      if (sim >= KEY_RECALL_THRESHOLD) {
        matches.push({ key, similarity: sim });
      }
    }
    return matches.sort((a, b) => b.similarity - a.similarity).slice(0, 10);
  }

  private keyIdf(keyId: string): number {
    const freq = this.links.filter(l => l.keyId === keyId).length;
    if (freq <= 1) return 1.0;
    let idf = 1.0 / freq;
    const key = this.keys.find(k => k.id === keyId);
    if (key && (key.keyType === 'name' || key.keyType === 'proper_noun')) {
      idf *= 0.5; // hub penalty
    }
    return idf;
  }

  private timeFactor(mem: Memory, now: number): number {
    const age = now - mem.createdAt;
    const decayRate = 1.0 - mem.depth * 0.7;
    const decay = Math.exp((-age * decayRate) / TIME_HALF_LIFE);
    return 0.5 + 0.5 * decay;
  }

  private getMemoriesForKey(keyId: string): Memory[] {
    const memIds = this.links.filter(l => l.keyId === keyId).map(l => l.memoryId);
    return this.memories.filter(m => memIds.includes(m.id));
  }

  private getKeysForMemory(memoryId: string): MemoryKey[] {
    const keyIds = this.links.filter(l => l.memoryId === memoryId).map(l => l.keyId);
    return this.keys.filter(k => keyIds.includes(k.id));
  }

  private findDuplicate(embedding: number[]): Memory | null {
    for (const mem of this.memories) {
      if (this.supersededBy.has(mem.id)) continue;
      const sim = cosineSim(embedding, mem.embedding);
      if (sim >= MEMORY_DEDUP_THRESHOLD) return mem;
    }
    return null;
  }

  private rebuildSupersededIndex(): void {
    this.supersededBy.clear();
    for (const mem of this.memories) {
      if (mem.supersedes) {
        this.supersededBy.set(mem.supersedes, mem.id);
      }
    }
  }

  // ─── Persistence ───────────────────────────────────────────────────

  /** Export full graph for persistence */
  export(): GraphData {
    return {
      keys: [...this.keys],
      memories: [...this.memories],
      links: [...this.links],
    };
  }

  /** Stats */
  stats(): { keys: number; memories: number; active: number; links: number } {
    return {
      keys: this.keys.length,
      memories: this.memories.length,
      active: this.memories.filter(m => !this.supersededBy.has(m.id)).length,
      links: this.links.length,
    };
  }
}
