/**
 * TreeConversationStoreJson — JSONL-based session tree with branching.
 *
 * File structure: {dataDir}/trees/{conversationId}.jsonl
 * Each line: JSON-serialized SessionEntry
 * Active leaf: {dataDir}/trees/{conversationId}.leaf (stores leaf ID)
 *
 * Append-only: entries are never deleted, only new branches added.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { messageId } from '@nexora/contracts';
import type {
  SessionEntry,
  SessionTreeNode,
  TreeConversationStore,
  StoreBackendInfo,
  DescribableStore,
} from '@nexora/contracts';

export class TreeConversationStoreJson implements TreeConversationStore, DescribableStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'trees');
  }

  describeBackend(): StoreBackendInfo {
    return { name: 'json-file', type: 'dev', durable: true, multiProcess: false };
  }

  private filePath(conversationId: string): string {
    return path.join(this.dir, `${conversationId}.jsonl`);
  }

  private leafPath(conversationId: string): string {
    return path.join(this.dir, `${conversationId}.leaf`);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  private async readAllEntries(conversationId: string): Promise<SessionEntry[]> {
    const file = this.filePath(conversationId);
    if (!fs.existsSync(file)) return [];
    const content = await fsp.readFile(file, 'utf-8');
    const entries: SessionEntry[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      entries.push(JSON.parse(line) as SessionEntry);
    }
    return entries;
  }

  async appendEntry(
    conversationId: string,
    entry: Omit<SessionEntry, 'id'>,
  ): Promise<string> {
    this.ensureDir();
    const id = messageId();
    const full: SessionEntry = { ...entry, id };

    fs.appendFileSync(this.filePath(conversationId), JSON.stringify(full) + '\n', 'utf-8');
    // Update active leaf
    await fsp.writeFile(this.leafPath(conversationId), id, 'utf-8');
    return id;
  }

  async branch(conversationId: string, fromEntryId: string): Promise<void> {
    this.ensureDir();
    // Just set the active leaf to the branch point
    await fsp.writeFile(this.leafPath(conversationId), fromEntryId, 'utf-8');
  }

  async getTree(conversationId: string): Promise<SessionTreeNode[]> {
    const entries = await this.readAllEntries(conversationId);
    if (entries.length === 0) return [];

    const byId = new Map<string, SessionTreeNode>();
    const roots: SessionTreeNode[] = [];

    for (const entry of entries) {
      byId.set(entry.id, { entry, children: [] });
    }

    for (const entry of entries) {
      const node = byId.get(entry.id)!;
      if (entry.parentId === null) {
        roots.push(node);
      } else {
        const parent = byId.get(entry.parentId);
        if (parent) parent.children.push(node);
        else roots.push(node); // orphaned → treat as root
      }
    }

    return roots;
  }

  async buildContext(
    conversationId: string,
    leafId?: string,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const entries = await this.readAllEntries(conversationId);
    if (entries.length === 0) return [];

    const targetLeaf = leafId ?? await this.getActiveLeaf(conversationId);
    if (!targetLeaf) return [];

    // Walk from leaf back to root
    const byId = new Map<string, SessionEntry>();
    for (const e of entries) byId.set(e.id, e);

    const chain: SessionEntry[] = [];
    let current: string | null = targetLeaf;
    while (current) {
      const entry = byId.get(current);
      if (!entry) break;
      chain.unshift(entry);
      current = entry.parentId;
    }

    return chain.map(e => ({ role: e.role, content: e.content }));
  }

  async getActiveLeaf(conversationId: string): Promise<string | null> {
    const file = this.leafPath(conversationId);
    if (!fs.existsSync(file)) return null;
    const content = await fsp.readFile(file, 'utf-8');
    return content.trim() || null;
  }

  async listLeaves(conversationId: string): Promise<string[]> {
    const entries = await this.readAllEntries(conversationId);
    if (entries.length === 0) return [];

    const hasChildren = new Set<string>();
    for (const e of entries) {
      if (e.parentId) hasChildren.add(e.parentId);
    }

    return entries.filter(e => !hasChildren.has(e.id)).map(e => e.id);
  }
}
