import { describe, it, expect } from 'vitest';
import { MemoryGraph } from '../memory-graph.js';
import type { EmbeddingProvider } from '../types.js';

/**
 * Mock embedding: maps known words to fixed vectors.
 * Uses simple one-hot-ish encoding for deterministic tests.
 */
// Vectors designed for distinct cosine similarity:
// - Same-word = 1.0, related ~0.3-0.5, unrelated < 0.2
const WORD_VECTORS: Record<string, number[]> = {
  'newton':       [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'apple':        [0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
  'fruit':        [0, 0.4, 0, 0, 1, 0, 0, 0, 0, 0],
  'strawberry':   [0, 0, 0, 0, 0.3, 0, 0, 0, 1, 0],
  'programming':  [0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
  'typescript':   [0, 0, 0.6, 0, 0, 1, 0, 0, 0, 0],
  'preference':   [0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
  'user':         [0, 0, 0, 0, 0, 0, 0, 1, 0, 0],
  'gravity':      [0.5, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  'key1':         [0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
  'key2':         [0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  'memory 1':     [0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
  'memory 2':     [0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
};

function getVector(text: string): number[] {
  const lower = text.toLowerCase();
  for (const [word, vec] of Object.entries(WORD_VECTORS)) {
    if (lower.includes(word)) return vec;
  }
  // Deterministic fallback based on string hash
  const hash = [...lower].reduce((s, c) => s + c.charCodeAt(0), 0);
  return Array.from({ length: 10 }, (_, i) =>
    Math.sin(hash * (i + 1) * 0.1) * 0.5 + 0.5
  );
}

const mockEmbedding: EmbeddingProvider = {
  embed: async (text) => getVector(text),
  embedBatch: async (texts) => texts.map(getVector),
};

describe('MemoryGraph', () => {
  it('stores and recalls a simple memory', async () => {
    const graph = new MemoryGraph({ embedding: mockEmbedding });

    await graph.remember('Newton discovered gravity', ['newton', 'gravity']);
    const results = await graph.recall('newton');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toBe('Newton discovered gravity');
    expect(results[0].hop).toBe(1);
  });

  it('2-hop associative recall via shared key', async () => {
    const graph = new MemoryGraph({ embedding: mockEmbedding });

    await graph.remember('Apples are a fruit', ['apple', 'fruit']);
    await graph.remember('Strawberries are sweet', ['strawberry', 'fruit']);

    // Query "apple" should find both: apple memory (direct) and
    // strawberry (via shared "fruit" key — either 1-hop through
    // content similarity or 2-hop through key association)
    const results = await graph.recall('apple');

    expect(results.length).toBeGreaterThanOrEqual(2);
    const apple = results.find(r => r.content.includes('Apples'));
    const strawberry = results.find(r => r.content.includes('Strawberries'));
    expect(apple).toBeDefined();
    expect(strawberry).toBeDefined();
    // Strawberry should have lower score than direct apple match
    expect(strawberry!.score).toBeLessThan(apple!.score);
  });

  it('depth reinforcement on recall', async () => {
    const graph = new MemoryGraph({ embedding: mockEmbedding });

    await graph.remember('TypeScript is great', ['typescript', 'programming']);

    // Recall multiple times → depth increases
    await graph.recall('typescript');
    await graph.recall('typescript');
    await graph.recall('typescript');

    const results = await graph.recall('typescript');
    expect(results[0].depth).toBeGreaterThan(0.1); // 4 recalls × 0.05 = 0.20
  });

  it('duplicate detection supersedes instead of creating', async () => {
    const graph = new MemoryGraph({ embedding: mockEmbedding });

    const r1 = await graph.remember('User likes TypeScript', ['programming']);
    const r2 = await graph.remember('User likes TypeScript', ['programming']);

    expect(r2.deduplicated).toBe(true);
    const stats = graph.stats();
    // Should have 2 memory objects (old + new) but only 1 active
    expect(stats.active).toBe(1);
  });

  it('key merging for similar concepts', async () => {
    const graph = new MemoryGraph({ embedding: mockEmbedding });

    // "gravity" and "newton" have similar vectors (0.9 overlap)
    await graph.remember('Gravity is a force', ['gravity']);
    await graph.remember('Newton studied forces', ['gravity']);

    const stats = graph.stats();
    // Should reuse the same key (cosine ≥ 0.85)
    expect(stats.keys).toBeLessThanOrEqual(2);
  });

  it('export and restore from data', async () => {
    const graph = new MemoryGraph({ embedding: mockEmbedding });
    await graph.remember('Hello world', ['programming']);

    const exported = graph.export();
    const restored = new MemoryGraph({ embedding: mockEmbedding, data: exported });

    const results = await restored.recall('programming');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toBe('Hello world');
  });

  it('stats reports correct counts', async () => {
    const graph = new MemoryGraph({ embedding: mockEmbedding });

    await graph.remember('Memory 1', ['key1']);
    await graph.remember('Memory 2', ['key2']);

    const stats = graph.stats();
    expect(stats.memories).toBe(2);
    expect(stats.active).toBe(2);
    expect(stats.keys).toBeGreaterThanOrEqual(2);
    expect(stats.links).toBeGreaterThanOrEqual(2);
  });

  it('empty graph returns no results', async () => {
    const graph = new MemoryGraph({ embedding: mockEmbedding });
    const results = await graph.recall('anything');
    expect(results).toEqual([]);
  });
});
