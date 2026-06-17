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
import { messageId } from '@dongkseo/contracts';
import type {
  SessionEntry,
  SessionTreeNode,
  TreeConversationStore,
  AppendEntryInput,
  StoreBackendInfo,
  DescribableStore,
} from '@dongkseo/contracts';

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

  /**
   * Append an entry to the current branch.
   * If parentId is null/undefined, defaults to the active leaf (auto-chaining).
   */
  async appendEntry(
    conversationId: string,
    entry: AppendEntryInput,
  ): Promise<string> {
    this.ensureDir();
    const id = messageId();

    // Auto-parent: if parentId not provided, use the active leaf
    let parentId = entry.parentId;
    if (parentId === undefined) {
      parentId = await this.getActiveLeaf(conversationId);
    }

    const full: SessionEntry = { ...entry, parentId, id };

    fs.appendFileSync(this.filePath(conversationId), JSON.stringify(full) + '\n', 'utf-8');
    // Update active leaf
    await fsp.writeFile(this.leafPath(conversationId), id, 'utf-8');
    return id;
  }

  /**
   * Branch from a specific entry. Validates that the entry exists.
   * Subsequent appendEntry calls will auto-parent from this point.
   */
  async branch(conversationId: string, fromEntryId: string): Promise<void> {
    this.ensureDir();
    // Validate the entry exists
    const entries = await this.readAllEntries(conversationId);
    if (!entries.some(e => e.id === fromEntryId)) {
      throw new Error(`Entry "${fromEntryId}" not found in conversation "${conversationId}"`);
    }
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
      if (entry.parentId == null) {
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
      current = entry.parentId ?? null;
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
