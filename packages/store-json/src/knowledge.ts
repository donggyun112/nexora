/**
 * KnowledgeStoreJson — Markdown CRUD.
 *
 * 파일 구조: {dataDir}/knowledge/{namespace}/{topic}.md
 * 참고: knowledge.tool.ts
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { KnowledgeStore, KnowledgeTopic } from '@nexora/contracts';

function sanitizeName(name: string): string {
  if (name.includes('/') || name.includes('..')) {
    throw new Error(`Invalid topic name: ${name}`);
  }
  return name;
}

export class KnowledgeStoreJson implements KnowledgeStore {
  private readonly baseDir: string;

  constructor(dataDir: string) {
    this.baseDir = path.join(dataDir, 'knowledge');
  }

  private nsDir(namespace: string): string {
    return path.join(this.baseDir, sanitizeName(namespace));
  }

  private topicPath(namespace: string, topic: string): string {
    return path.join(this.nsDir(namespace), `${sanitizeName(topic)}.md`);
  }

  private ensureNsDir(namespace: string): void {
    const dir = this.nsDir(namespace);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  async list(namespace: string): Promise<KnowledgeTopic[]> {
    const dir = this.nsDir(namespace);
    if (!fs.existsSync(dir)) return [];

    const files = (await fsp.readdir(dir)).filter(f => f.endsWith('.md')).sort();
    const topics: KnowledgeTopic[] = [];

    for (const file of files) {
      const content = await fsp.readFile(path.join(dir, file), 'utf-8');
      const firstHeading = content.split('\n').find(l => l.startsWith('# '))?.slice(2);
      const name = path.basename(file, '.md');
      topics.push({
        name,
        title: firstHeading ?? name,
        lineCount: content.split('\n').filter(Boolean).length,
      });
    }

    return topics;
  }

  async read(namespace: string, topic: string): Promise<string | null> {
    const file = this.topicPath(namespace, topic);
    if (!fs.existsSync(file)) return null;
    return fsp.readFile(file, 'utf-8');
  }

  async write(namespace: string, topic: string, content: string): Promise<void> {
    this.ensureNsDir(namespace);
    await fsp.writeFile(this.topicPath(namespace, topic), content + '\n', 'utf-8');
  }

  async append(namespace: string, topic: string, content: string): Promise<void> {
    const file = this.topicPath(namespace, topic);
    if (!fs.existsSync(file)) {
      throw new Error(`Topic "${topic}" not found in namespace "${namespace}". Use write() first.`);
    }
    fs.appendFileSync(file, `\n${content}\n`, 'utf-8');
  }

  async delete(namespace: string, topic: string): Promise<void> {
    const file = this.topicPath(namespace, topic);
    if (fs.existsSync(file)) await fsp.unlink(file);
  }
}
