/**
 * SkillLoader — parse SKILL.md files (YAML frontmatter + Markdown body).
 *
 * Discovers skills from filesystem directories, parses frontmatter,
 * and returns structured Skill objects.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
    requires_toolsets: Array.isArray(obj['requires-toolsets'] ?? obj.requires_toolsets) ? (obj['requires-toolsets'] ?? obj.requires_toolsets) as string[] : undefined,
    fallback_for_toolsets: Array.isArray(obj['fallback-for-toolsets'] ?? obj.fallback_for_toolsets) ? (obj['fallback-for-toolsets'] ?? obj.fallback_for_toolsets) as string[] : undefined,
    requires_env: Array.isArray(obj['requires-env'] ?? obj.requires_env) ? (obj['requires-env'] ?? obj.requires_env) as string[] : undefined,
    requires_bins: Array.isArray(obj['requires-bins'] ?? obj.requires_bins) ? (obj['requires-bins'] ?? obj.requires_bins) as string[] : undefined,
    always: obj.always === true ? true : undefined,
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
  const entries = await fsp.readdir(dir, { withFileTypes: true });

  for (const dirent of entries) {
    const entryPath = path.join(dir, dirent.name);

    // Skip symlinks to prevent loops and directory escapes
    if (dirent.isSymbolicLink()) continue;

    const stat = await fsp.stat(entryPath);

    if (stat.isDirectory()) {
      // Check for SKILL.md in this directory
      const skillFile = path.join(entryPath, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        // Skip if SKILL.md itself is a symlink (prevent escape from discovery root)
        const fileStat = await fsp.lstat(skillFile);
        if (fileStat.isSymbolicLink()) continue;
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
    } else if (dirent.name.endsWith('.md') && dirent.name !== 'README.md') {
      // Skip symlinked .md files
      const fileStat = await fsp.lstat(entryPath);
      if (fileStat.isSymbolicLink()) continue;
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

// ─── Skill eligibility filtering (hermes + openclaw pattern) ───────────────

const PLATFORM_MAP: Record<string, string> = {
  macos: 'darwin', linux: 'linux', windows: 'win32',
};

export interface SkillEligibilityContext {
  /** Current platform (process.platform) */
  platform?: string;
  /** Available tool names */
  availableTools?: string[];
  /** Available toolset names */
  availableToolsets?: string[];
  /** Available environment variable names */
  envVars?: string[];
}

/** Check if a binary is available on PATH. Cached per process. */
const binCache = new Map<string, boolean>();
function isBinAvailable(bin: string): boolean {
  let result = binCache.get(bin);
  if (result !== undefined) return result;
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
    result = true;
  } catch {
    result = false;
  }
  binCache.set(bin, result);
  return result;
}

/**
 * Filter skills by eligibility. Checks platform, required tools/toolsets,
 * env vars, and conditional activation rules.
 */
export function filterEligibleSkills(
  skills: Skill[],
  ctx: SkillEligibilityContext = {},
): Skill[] {
  const platform = ctx.platform ?? process.platform;
  const toolsets = new Set(ctx.availableToolsets ?? []);
  const tools = new Set(ctx.availableTools ?? []);
  const envVars = new Set(ctx.envVars ?? Object.keys(process.env));

  return skills.filter(skill => {
    const m = skill.meta;
    if (m.always) return true;

    // Platform check
    if (m.platforms?.length) {
      const match = m.platforms.some(p => platform.startsWith(PLATFORM_MAP[p] ?? p));
      if (!match) return false;
    }

    // Required tools
    if (m.allowedTools?.length && tools.size > 0) {
      if (!m.allowedTools.every(t => tools.has(t))) return false;
    }

    // Required toolsets
    if (m.requires_toolsets?.length) {
      if (!m.requires_toolsets.every(ts => toolsets.has(ts))) return false;
    }

    // Fallback: activate only when target toolsets are MISSING
    if (m.fallback_for_toolsets?.length) {
      if (m.fallback_for_toolsets.every(ts => toolsets.has(ts))) return false;
    }

    // Required env vars
    if (m.requires_env?.length) {
      if (!m.requires_env.every(e => envVars.has(e))) return false;
    }

    // Required binaries on PATH
    if (m.requires_bins?.length) {
      if (!m.requires_bins.every(bin => isBinAvailable(bin))) return false;
    }

    return true;
  });
}

// ─── mtime-based cache ─────────────────────────────────────────────────────

interface CacheEntry {
  skill: Skill;
  mtime: number;
}

/**
 * Cached skill loader — only re-parses files that changed since last load.
 * Separates path discovery from parsing: stats files first, only parses
 * cache misses or changed files.
 */
export class CachedSkillLoader {
  private cache = new Map<string, CacheEntry>();

  async loadFromDir(dir: string): Promise<Skill[]> {
    if (!fs.existsSync(dir)) return [];

    // Phase 1: discover skill file paths (no parsing)
    const paths = await discoverSkillPaths(dir);
    const result: Skill[] = [];
    const seenPaths = new Set<string>();

    // Phase 2: stat each path, only parse on cache miss/change
    for (const filePath of paths) {
      seenPaths.add(filePath);
      const stat = await fsp.stat(filePath);
      const mtime = stat.mtimeMs;
      const cached = this.cache.get(filePath);

      if (cached && cached.mtime === mtime) {
        result.push(cached.skill);
      } else {
        // Cache miss or changed — parse
        const content = await fsp.readFile(filePath, 'utf-8');
        try {
          const skill = parseSkillFile(content, filePath);
          this.cache.set(filePath, { skill, mtime });
          result.push(skill);
        } catch {
          // Skip malformed
        }
      }
    }

    // Evict removed paths
    for (const key of this.cache.keys()) {
      if (!seenPaths.has(key)) this.cache.delete(key);
    }

    return result;
  }

  invalidate(): void {
    this.cache.clear();
  }
}

/** Discover skill file paths without parsing content. */
async function discoverSkillPaths(dir: string): Promise<string[]> {
  if (!fs.existsSync(dir)) return [];
  const paths: string[] = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });

  for (const dirent of entries) {
    if (dirent.isSymbolicLink()) continue;
    const entryPath = path.join(dir, dirent.name);
    const stat = await fsp.stat(entryPath);

    if (stat.isDirectory()) {
      const skillFile = path.join(entryPath, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        const fileStat = await fsp.lstat(skillFile);
        if (!fileStat.isSymbolicLink()) paths.push(skillFile);
      } else {
        const nested = await discoverSkillPaths(entryPath);
        paths.push(...nested);
      }
    } else if (dirent.name.endsWith('.md') && dirent.name !== 'README.md') {
      const fileStat = await fsp.lstat(entryPath);
      if (!fileStat.isSymbolicLink()) paths.push(entryPath);
    }
  }

  return paths;
}
