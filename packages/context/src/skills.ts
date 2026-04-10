/**
 * SkillLoader — 스킬 메뉴 자동 생성.
 *
 * 디렉토리 구조:
 *   contextRoot/
 *     skills/
 *       {skill-name}.md         # 프론트매터(name, description) + 본문
 *     tenants/{tenantId}/skills/
 *       {skill-name}.md         # 테넌트 오버라이드
 *
 * 스킬 메뉴 → 시스템 프롬프트에 포함되어 에이전트가 load_skill 도구를 호출하도록 유도.
 *
 * 참고: system-prompt.ts loadSkillsMenu()
 */

import fs from 'node:fs';
import path from 'node:path';

export interface SkillEntry {
  name: string;
  description: string;
}

export interface SkillLoaderOptions {
  root: string;
  cache?: boolean;
}

const SKILLS_HEADER =
  '## Available Skills\n\n' +
  'When a user request matches a skill below, you MUST call `load_skill` FIRST before using related tools. ' +
  'The skill provides critical schema, patterns, and context that prevent unnecessary exploration.\n\n';

export class SkillLoader {
  private readonly root: string;
  private readonly cacheEnabled: boolean;
  private readonly cache = new Map<string, SkillEntry[]>();

  constructor(options: SkillLoaderOptions) {
    this.root = path.resolve(options.root);
    this.cacheEnabled = options.cache ?? true;
  }

  /** 스킬 목록 로드 (테넌트 오버라이드 머지) */
  list(tenantId?: string): SkillEntry[] {
    const cacheKey = tenantId ?? '__default__';
    if (this.cacheEnabled && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const defaultDir = path.join(this.root, 'skills');
    const tenantDir = tenantId
      ? path.join(this.root, 'tenants', tenantId, 'skills')
      : null;

    const entriesByName = new Map<string, SkillEntry>();

    if (fs.existsSync(defaultDir)) {
      for (const entry of this.readDir(defaultDir)) {
        entriesByName.set(entry.name, entry);
      }
    }

    if (tenantDir && fs.existsSync(tenantDir)) {
      for (const entry of this.readDir(tenantDir)) {
        entriesByName.set(entry.name, entry);
      }
    }

    const list = Array.from(entriesByName.values()).sort((a, b) => a.name.localeCompare(b.name));
    if (this.cacheEnabled) this.cache.set(cacheKey, list);
    return list;
  }

  /** 시스템 프롬프트에 삽입할 스킬 메뉴 텍스트 */
  buildMenu(tenantId?: string): string {
    const skills = this.list(tenantId);
    if (skills.length === 0) return '';

    const lines = skills.map(s =>
      `- ${s.name}${s.description ? `: ${s.description}` : ''}`,
    );
    return SKILLS_HEADER + lines.join('\n');
  }

  clearCache(): void {
    this.cache.clear();
  }

  private readDir(dir: string): SkillEntry[] {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
    const entries: SkillEntry[] = [];
    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const fm = parseFrontmatter(content);
      const name = fm.name ?? path.basename(file, '.md');
      const description = fm.description ?? '';
      entries.push({ name, description });
    }
    return entries;
  }
}

/** 단순 frontmatter 파서 (key: value 라인 기반) */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && value) result[key] = value;
  }
  return result;
}
