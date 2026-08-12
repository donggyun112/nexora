/** Source-neutral skill registry with bounded metadata-only disclosure. */

import { DirectorySkillSource } from './skill-loader.js';
import type { Skill, SkillMetadata, SkillSource } from './types.js';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DEFAULT_CATALOG_BUDGET = 8_000;
const DESCRIPTION_LIMIT = 250;

export interface SkillRegistryOptions {
  catalogCharBudget?: number;
}

/** Later sources override earlier sources by exact skill name. */
export class SkillRegistry {
  private readonly sources: readonly SkillSource[];
  private readonly catalogCharBudget: number;
  private metadata: Map<string, SkillMetadata> | null = null;
  private owners = new Map<string, SkillSource>();
  private refreshing: Promise<readonly SkillMetadata[]> | null = null;

  constructor(
    sources: readonly (SkillSource | string)[],
    options: SkillRegistryOptions = {},
  ) {
    this.catalogCharBudget = options.catalogCharBudget ?? DEFAULT_CATALOG_BUDGET;
    if (this.catalogCharBudget < 256) {
      throw new Error('skill catalog budget must be at least 256 characters');
    }
    this.sources = sources.map(source =>
      typeof source === 'string' ? new DirectorySkillSource(source) : source);
  }

  async refresh(): Promise<readonly SkillMetadata[]> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshNow();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  clear(): void {
    this.metadata = null;
    this.owners.clear();
  }

  async list(): Promise<readonly SkillMetadata[]> {
    if (!this.metadata) await this.refresh();
    return this.snapshot();
  }

  snapshot(): readonly SkillMetadata[] {
    if (!this.metadata) return [];
    return [...this.metadata.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async load(name: string): Promise<Skill | null> {
    await this.list();
    const owner = this.owners.get(name);
    if (!owner) return null;
    const skill = await owner.load(name);
    if (skill && skill.name !== name) {
      throw new Error(`skill source returned ${JSON.stringify(skill.name)} for ${JSON.stringify(name)}`);
    }
    return skill;
  }

  async catalog(): Promise<string> {
    await this.list();
    return this.catalogSnapshot();
  }

  catalogSnapshot(): string {
    const skills = this.snapshot();
    if (skills.length === 0) return '';
    const head = '<available_skills>\n';
    const tail = '\n</available_skills>';
    const entries = skills.map(skill =>
      `  - ${escapeHtml(skill.name)}: ${escapeHtml(skill.description.slice(0, DESCRIPTION_LIMIT))}`);
    const full = head + entries.join('\n') + tail;
    if (full.length <= this.catalogCharBudget) return full;

    const kept: string[] = [];
    for (const skill of skills) {
      const entry = `  - ${escapeHtml(skill.name)}`;
      const remaining = skills.length - kept.length - 1;
      const suffix = remaining > 0 ? `\n  ... ${remaining} more` : '';
      if ((head + [...kept, entry].join('\n') + suffix + tail).length > this.catalogCharBudget) break;
      kept.push(entry);
    }
    const omitted = skills.length - kept.length;
    const suffix = omitted ? `\n  ... ${omitted} more` : '';
    return head + kept.join('\n') + suffix + tail;
  }

  private async refreshNow(): Promise<readonly SkillMetadata[]> {
    const found = new Map<string, SkillMetadata>();
    const owners = new Map<string, SkillSource>();
    for (const source of this.sources) {
      for (const metadata of await source.list()) {
        if (!NAME.test(metadata.name)) {
          throw new Error(`invalid skill name: ${JSON.stringify(metadata.name)}`);
        }
        found.set(metadata.name, { ...metadata });
        owners.set(metadata.name, source);
      }
    }
    this.metadata = found;
    this.owners = owners;
    return this.snapshot();
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
