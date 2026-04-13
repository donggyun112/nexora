/**
 * SkillLoader — parse SKILL.md files (YAML frontmatter + Markdown body).
 *
 * Discovers skills from filesystem directories, parses frontmatter,
 * and returns structured Skill objects.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Skill, SkillFrontmatter } from './types.js';

/**
 * Parse a single SKILL.md file into a Skill object.
 *
 * Expected format:
 * ```
 * ---
 * name: my-skill
 * description: What this skill does
 * tags: [tag1, tag2]
 * version: 1
 * author: system
 * ---
 *
 * # Skill body in Markdown
 * ```
 */
export function parseSkillFile(content: string, source: string): Skill {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    throw new Error(`Invalid SKILL.md format (no frontmatter): ${source}`);
  }

  const rawFrontmatter = frontmatterMatch[1];
  const body = frontmatterMatch[2].trim();

  const meta = parseYamlFrontmatter(rawFrontmatter, source);
  return { meta, body, source };
}

/**
 * Minimal YAML frontmatter parser — handles the key-value + array format
 * used by SKILL.md files. Supports inline arrays [a, b, c], YAML-style
 * list arrays (- item), nested keys via dot notation, and basic types.
 * No external YAML dependency needed.
 */
function parseYamlFrontmatter(raw: string, source: string): SkillFrontmatter {
  const lines = raw.split('\n');
  const obj: Record<string, unknown> = {};
  let currentArrayKey: string | null = null;

  for (const line of lines) {
    // YAML-style list item (continuation of previous key)
    const listMatch = line.match(/^(\s+)-\s+(.+)$/);
    if (listMatch && currentArrayKey) {
      const arr = obj[currentArrayKey] as unknown[];
      arr.push(listMatch[2].trim().replace(/^["']|["']$/g, ''));
      continue;
    }

    // Key-value pair
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (!match) {
      currentArrayKey = null;
      continue;
    }
    const [, key, rawValue] = match;
    const value = rawValue.trim();

    if (value === '') {
      // Key with no value — next lines might be array items
      currentArrayKey = key;
      obj[key] = [];
      continue;
    }

    currentArrayKey = null;

    // Inline array: [tag1, tag2, tag3]
    if (value.startsWith('[') && value.endsWith(']')) {
      obj[key] = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    } else if (value === 'true') {
      obj[key] = true;
    } else if (value === 'false') {
      obj[key] = false;
    } else if (/^\d+$/.test(value)) {
      obj[key] = parseInt(value, 10);
    } else if (/^\d+\.\d+$/.test(value)) {
      obj[key] = parseFloat(value);
    } else {
      obj[key] = value.replace(/^["']|["']$/g, '');
    }
  }

  if (!obj.name || typeof obj.name !== 'string') {
    throw new Error(`SKILL.md missing required field "name": ${source}`);
  }

  return {
    name: obj.name as string,
    description: (obj.description as string) ?? '',
    tags: Array.isArray(obj.tags) ? obj.tags as string[] : [],
    trigger: obj.trigger as string | undefined,
    version: typeof obj.version === 'number' ? obj.version : 1,
    author: (obj.author as 'system' | 'agent') ?? 'system',
    allowedTools: Array.isArray(obj['allowed-tools']) ? obj['allowed-tools'] as string[] : undefined,
    platforms: Array.isArray(obj.platforms) ? obj.platforms as string[] : undefined,
    prerequisites: Array.isArray(obj.prerequisites) ? obj.prerequisites as string[] : undefined,
  };
}

/**
 * Recursively load SKILL.md files from a directory tree.
 * Supports: skills/category/skill-name/SKILL.md and flat .md files.
 */
export async function loadSkillsFromDir(dir: string): Promise<Skill[]> {
  if (!fs.existsSync(dir)) return [];
  return walkDir(dir);
}

async function walkDir(dir: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  const entries = await fsp.readdir(dir);

  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    const stat = await fsp.stat(entryPath);

    if (stat.isDirectory()) {
      // Check for SKILL.md in this directory
      const skillFile = path.join(entryPath, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        const content = await fsp.readFile(skillFile, 'utf-8');
        try {
          skills.push(parseSkillFile(content, skillFile));
        } catch {
          // Skip malformed skill files
        }
      } else {
        // Recurse into subdirectory (category folders)
        const nested = await walkDir(entryPath);
        skills.push(...nested);
      }
    } else if (entry.endsWith('.md') && entry !== 'README.md') {
      const content = await fsp.readFile(entryPath, 'utf-8');
      try {
        skills.push(parseSkillFile(content, entryPath));
      } catch {
        // Skip non-skill markdown files
      }
    }
  }

  return skills;
}

// ─── Multi-source discovery ────────────────────────────────────────────────

/**
 * Default skill source directories, in priority order (last wins).
 * Caller can override or extend.
 */
export function defaultSkillSources(projectRoot: string): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return [
    path.join(home, '.nexora', 'skills'),        // global user skills
    path.join(projectRoot, '.nexora', 'skills'),  // project-level skills
    path.join(projectRoot, 'skills'),             // project skills dir
  ].filter(Boolean);
}

/**
 * Load skills from multiple directories (e.g., builtin + user-created).
 * Later directories override earlier ones by name.
 */
export async function loadSkills(...dirs: string[]): Promise<Skill[]> {
  const byName = new Map<string, Skill>();

  for (const dir of dirs) {
    const skills = await loadSkillsFromDir(dir);
    for (const skill of skills) {
      byName.set(skill.meta.name, skill);
    }
  }

  return Array.from(byName.values());
}

// ─── mtime-based cache ─────────────────────────────────────────────────────

interface CacheEntry {
  skill: Skill;
  mtime: number;
}

/**
 * Cached skill loader — only re-parses files that changed since last load.
 * Reduces startup time when skill directories are large.
 */
export class CachedSkillLoader {
  private cache = new Map<string, CacheEntry>();

  async loadFromDir(dir: string): Promise<Skill[]> {
    if (!fs.existsSync(dir)) return [];

    const fresh = await walkDir(dir);
    const result: Skill[] = [];

    for (const skill of fresh) {
      const cached = this.cache.get(skill.source);
      const stat = await fsp.stat(skill.source);
      const mtime = stat.mtimeMs;

      if (cached && cached.mtime >= mtime) {
        result.push(cached.skill);
      } else {
        this.cache.set(skill.source, { skill, mtime });
        result.push(skill);
      }
    }

    return result;
  }

  invalidate(): void {
    this.cache.clear();
  }
}
