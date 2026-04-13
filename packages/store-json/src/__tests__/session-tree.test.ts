import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TreeConversationStoreJson } from '../session-tree.js';

let tmpDir: string;
let store: TreeConversationStoreJson;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-tree-test-'));
  store = new TreeConversationStoreJson(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('TreeConversationStoreJson', () => {
  it('appends entries with auto-parenting and builds linear context', async () => {
    await store.appendEntry('conv1', {
      parentId: null,
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
    });

    // Auto-parent: parentId omitted, chains from active leaf
    await store.appendEntry('conv1', {
      parentId: undefined,
      role: 'assistant',
      content: 'Hi there',
      timestamp: Date.now(),
    });

    const context = await store.buildContext('conv1');
    expect(context).toHaveLength(2);
    expect(context[0].content).toBe('Hello');
    expect(context[1].content).toBe('Hi there');
  });

  it('supports branching with auto-parenting', async () => {
    const id1 = await store.appendEntry('conv1', {
      parentId: null, role: 'user', content: 'Start', timestamp: 1,
    });
    const id2 = await store.appendEntry('conv1', {
      parentId: undefined, role: 'assistant', content: 'Path A', timestamp: 2,
    });

    // Branch from id1 (go back before "Path A")
    await store.branch('conv1', id1);
    // Auto-parents from branch point (id1)
    const id3 = await store.appendEntry('conv1', {
      parentId: undefined, role: 'assistant', content: 'Path B', timestamp: 3,
    });

    // Context from branch B
    const contextB = await store.buildContext('conv1', id3);
    expect(contextB).toHaveLength(2);
    expect(contextB[1].content).toBe('Path B');

    // Context from branch A still works
    const contextA = await store.buildContext('conv1', id2);
    expect(contextA).toHaveLength(2);
    expect(contextA[1].content).toBe('Path A');
  });

  it('branch() rejects nonexistent entry', async () => {
    await store.appendEntry('conv1', {
      parentId: null, role: 'user', content: 'Root', timestamp: 1,
    });
    await expect(store.branch('conv1', 'nonexistent')).rejects.toThrow(/not found/);
  });

  it('lists leaf entries', async () => {
    const id1 = await store.appendEntry('conv1', {
      parentId: null, role: 'user', content: 'Root', timestamp: 1,
    });
    const id2 = await store.appendEntry('conv1', {
      parentId: undefined, role: 'assistant', content: 'Leaf A', timestamp: 2,
    });
    await store.branch('conv1', id1);
    const id3 = await store.appendEntry('conv1', {
      parentId: undefined, role: 'assistant', content: 'Leaf B', timestamp: 3,
    });

    const leaves = await store.listLeaves('conv1');
    expect(leaves.sort()).toEqual([id2, id3].sort());
  });

  it('getTree returns hierarchical structure', async () => {
    const id1 = await store.appendEntry('conv1', {
      parentId: null, role: 'user', content: 'Root', timestamp: 1,
    });
    await store.appendEntry('conv1', {
      parentId: undefined, role: 'assistant', content: 'Child', timestamp: 2,
    });

    const tree = await store.getTree('conv1');
    expect(tree).toHaveLength(1);
    expect(tree[0].entry.content).toBe('Root');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].entry.content).toBe('Child');
  });

  it('returns empty for nonexistent conversation', async () => {
    expect(await store.buildContext('nope')).toEqual([]);
    expect(await store.getTree('nope')).toEqual([]);
    expect(await store.getActiveLeaf('nope')).toBeNull();
  });

  it('describeBackend reports dev store', () => {
    const info = store.describeBackend();
    expect(info.type).toBe('dev');
    expect(info.name).toBe('json-file');
  });
});
