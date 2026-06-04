/**
 * Skill menu builder — system-prompt 에 박히는 `<available_skills>` 블록 생성.
 *
 * Hermes prompt_builder.build_skills_system_prompt 의 행동을 가져온 것:
 *   - 두 디렉토리(agent + shared) 의 SKILL.md / .md 를 sync 로 walk
 *   - parseSkillFile 로 frontmatter 표준 파싱
 *   - 호환성 필터 (availableTools / requires_toolsets / requires_env / platforms)
 *   - 카테고리(frontmatter tags 첫 항목 → 디렉토리 segment → 'general') 별 그룹핑
 *   - `<available_skills>` XML 블록 + 호출자가 주입한 안내문구로 직렬화
 *   - 디스크 mtime 기반 in-process LRU 캐시
 *
 * 의도적으로 빠진 것:
 *   - bundles / inline-shell preprocessing / reload tool — 별도 모듈
 *   - disk snapshot — 일반 nexora 사용처는 in-process LRU 로 충분
 *
 * 안내문구(preamble, trailingHint)는 호출자가 옵션으로 주입 — 패키지는 정책 텍스트
 * 하드코딩하지 않는다 (다국어/봇별 톤 분리).
 */

import { readdirSync, readFileSync, statSync, type Dirent, type Stats } from 'node:fs';
import path from 'node:path';
import { parseSkillFile } from './skill-loader.js';
import type { Skill } from './types.js';

/** 안내문구 옵션 — 정책 텍스트는 호출자 책임. */
export interface SkillMenuPreamble {
  /** XML 블록 *앞* 에 박힐 텍스트(헤딩 + 안내). 비우면 헤딩만 출력. */
  readonly head?: string;
  /** XML 블록 *뒤* 에 박힐 추가 안내(예: 특정 에이전트의 평가 위임 규약 등). */
  readonly tail?: string;
}

/** 메뉴 호환성 필터 컨텍스트 — `filterEligibleSkills` 의 그것과 동일. */
export interface SkillMenuFilter {
  readonly availableTools?: ReadonlySet<string>;
  readonly availableToolsets?: ReadonlySet<string>;
  readonly envVars?: ReadonlySet<string>;
  readonly platform?: string;
}

export interface BuildSkillMenuOptions {
  readonly agentSkillsDir: string;
  readonly sharedSkillsDir?: string;
  readonly filter?: SkillMenuFilter;
  readonly preamble?: SkillMenuPreamble;
  /** 캐시 키에 들어갈 식별자(예: agent name) — 같은 디렉토리라도 안내문구가 달라지면 분리 캐시. */
  readonly cacheScope?: string;
}

interface DiscoveredSkill {
  readonly skill: Skill;
  readonly directorySegment: string | null;
}

interface CacheEntry {
  readonly key: string;
  readonly menu: string;
}

export interface SkillMenuSnapshotEntry {
  readonly name: string;
  readonly description: string;
}

const CACHE_MAX = 32;
const cache = new Map<string, CacheEntry>();
const lastSnapshotByDirs = new Map<string, SkillMenuSnapshotEntry[]>();

function dirSignature(dir: string): string {
  try {
    const st = statSync(dir);
    return `${dir}:${st.mtimeMs}`;
  } catch {
    return `${dir}:missing`;
  }
}

function recursiveStatSignature(dir: string): string {
  const parts: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true, encoding: 'utf-8' });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = path.join(cur, entry.name);
      let st: Stats;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(p);
      } else if (entry.name.endsWith('.md')) {
        parts.push(`${p}:${st.mtimeMs}:${st.size}`);
      }
    }
  }
  parts.sort();
  return parts.join('|');
}

function cacheKey(options: BuildSkillMenuOptions): string {
  const tools = options.filter?.availableTools
    ? Array.from(options.filter.availableTools).sort().join(',')
    : '';
  const toolsets = options.filter?.availableToolsets
    ? Array.from(options.filter.availableToolsets).sort().join(',')
    : '';
  const envVars = options.filter?.envVars
    ? Array.from(options.filter.envVars).sort().join(',')
    : '';
  const sharedDir = options.sharedSkillsDir ?? '';
  return [
    options.cacheScope ?? '',
    tools,
    toolsets,
    envVars,
    options.filter?.platform ?? '',
    options.preamble?.head ?? '',
    options.preamble?.tail ?? '',
    dirSignature(options.agentSkillsDir),
    dirSignature(sharedDir),
    recursiveStatSignature(options.agentSkillsDir),
    recursiveStatSignature(sharedDir),
  ].join('||');
}

function snapshotKey(agentSkillsDir: string, sharedSkillsDir?: string): string {
  return [agentSkillsDir, sharedSkillsDir ?? ''].join('||');
}

function discoverSkills(rootDir: string): DiscoveredSkill[] {
  const result: DiscoveredSkill[] = [];
  walk(rootDir, rootDir, result);
  return result;
}

function walk(rootDir: string, currentDir: string, out: DiscoveredSkill[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(currentDir, { withFileTypes: true, encoding: 'utf-8' });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      const skillFile = path.join(fullPath, 'SKILL.md');
      let parsed: Skill | null = null;
      try {
        const body = readFileSync(skillFile, 'utf-8');
        parsed = parseSkillFile(body, skillFile);
      } catch {
        parsed = null;
      }
      if (parsed) {
        out.push({
          skill: parsed,
          directorySegment: relativeSegment(rootDir, fullPath),
        });
      }
      walk(rootDir, fullPath, out);
    } else if (
      entry.name.endsWith('.md') &&
      entry.name !== 'README.md' &&
      entry.name !== 'SKILL.md'
    ) {
      let parsed: Skill | null = null;
      try {
        const body = readFileSync(fullPath, 'utf-8');
        parsed = parseSkillFile(body, fullPath);
      } catch {
        parsed = null;
      }
      if (!parsed) continue;
      out.push({
        skill: parsed,
        directorySegment: relativeSegment(rootDir, path.dirname(fullPath)),
      });
    }
  }
}

function relativeSegment(rootDir: string, fullDir: string): string | null {
  const rel = path.relative(rootDir, fullDir);
  if (!rel || rel === '.') return null;
  const seg = rel.split(path.sep)[0];
  return seg || null;
}

function isCompatible(skill: Skill, filter: SkillMenuFilter | undefined): boolean {
  if (!filter) return true;
  const meta = skill.meta;
  if (meta.always) return true;
  if (Array.isArray(meta.allowedTools) && meta.allowedTools.length > 0 && filter.availableTools) {
    for (const t of meta.allowedTools) {
      if (!filter.availableTools.has(t)) return false;
    }
  }
  if (Array.isArray(meta.requires_toolsets) && filter.availableToolsets) {
    for (const t of meta.requires_toolsets) {
      if (!filter.availableToolsets.has(t)) return false;
    }
  }
  if (Array.isArray(meta.requires_env) && filter.envVars) {
    for (const e of meta.requires_env) {
      if (!filter.envVars.has(e)) return false;
    }
  }
  if (Array.isArray(meta.platforms) && filter.platform && meta.platforms.length > 0) {
    if (!meta.platforms.includes(filter.platform)) return false;
  }
  return true;
}

function pickCategory(found: DiscoveredSkill): string {
  const tags = found.skill.meta.tags;
  if (Array.isArray(tags) && tags.length > 0 && typeof tags[0] === 'string' && tags[0].trim()) {
    return tags[0].trim();
  }
  return found.directorySegment ?? 'general';
}

interface BuildResult {
  readonly categories: ReadonlyArray<{
    readonly category: string;
    readonly entries: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  }>;
  readonly total: number;
}

function buildStructure(
  agentSkills: DiscoveredSkill[],
  sharedSkills: DiscoveredSkill[],
  filter: SkillMenuFilter | undefined,
): BuildResult {
  const byName = new Map<string, DiscoveredSkill>();
  for (const it of agentSkills) byName.set(it.skill.meta.name, it);
  for (const it of sharedSkills) {
    if (!byName.has(it.skill.meta.name)) byName.set(it.skill.meta.name, it);
  }

  const buckets = new Map<string, Array<{ name: string; description: string }>>();
  for (const found of byName.values()) {
    if (!isCompatible(found.skill, filter)) continue;
    const cat = pickCategory(found);
    const list = buckets.get(cat) ?? [];
    list.push({
      name: found.skill.meta.name,
      description: found.skill.meta.description ?? '',
    });
    buckets.set(cat, list);
  }

  const categories = Array.from(buckets.entries())
    .map(([category, entries]) => ({
      category,
      entries: entries.slice().sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));

  const total = categories.reduce((acc, c) => acc + c.entries.length, 0);
  return { categories, total };
}

function renderXmlBlock(result: BuildResult): string {
  if (result.total === 0) return '';
  const lines: string[] = ['<available_skills>'];
  for (const { category, entries } of result.categories) {
    lines.push(`  ${category}:`);
    for (const e of entries) {
      lines.push(e.description ? `    - ${e.name}: ${e.description}` : `    - ${e.name}`);
    }
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

/**
 * 시스템 프롬프트에 박을 skill 메뉴 텍스트 빌드.
 *
 * 결과 포맷:
 *   <preamble.head>          (있으면)
 *   <available_skills>
 *     category-a:
 *       - skill-name: description
 *       ...
 *   </available_skills>
 *   <preamble.tail>          (있으면)
 *
 * 빈 카테고리 / 빈 결과는 빈 문자열 반환.
 */
export function buildSkillMenu(options: BuildSkillMenuOptions): string {
  const key = cacheKey(options);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.menu;
  }

  const agentSkills = discoverSkills(options.agentSkillsDir);
  const sharedSkills = options.sharedSkillsDir
    ? discoverSkills(options.sharedSkillsDir)
    : [];
  rememberSkillMenuSnapshot(
    options.agentSkillsDir,
    options.sharedSkillsDir,
    snapshotFromDiscovered(agentSkills, sharedSkills),
  );
  const structure = buildStructure(agentSkills, sharedSkills, options.filter);

  if (structure.total === 0) {
    cache.set(key, { key, menu: '' });
    return '';
  }

  const xml = renderXmlBlock(structure);
  const head = options.preamble?.head ? `${options.preamble.head}\n\n` : '';
  const tail = options.preamble?.tail ? `\n\n${options.preamble.tail}` : '';
  const menu = `\n\n${head}${xml}${tail}\n`;

  cache.set(key, { key, menu });
  while (cache.size > CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    cache.delete(firstKey);
  }

  return menu;
}

/** 디스크 변경 / reload 호출 시 캐시 비우기. */
export function invalidateSkillMenuCache(): void {
  cache.clear();
}

export function getLastSkillMenuSnapshot(
  agentSkillsDir: string,
  sharedSkillsDir?: string,
): SkillMenuSnapshotEntry[] | null {
  const snapshot = lastSnapshotByDirs.get(snapshotKey(agentSkillsDir, sharedSkillsDir));
  return snapshot ? snapshot.map(s => ({ ...s })) : null;
}

export function refreshSkillMenuSnapshot(
  agentSkillsDir: string,
  sharedSkillsDir?: string,
): SkillMenuSnapshotEntry[] {
  const snapshot = snapshotSkills(agentSkillsDir, sharedSkillsDir);
  rememberSkillMenuSnapshot(agentSkillsDir, sharedSkillsDir, snapshot);
  return snapshot;
}

/**
 * 현재 디스크 상태로 스킬 인덱스 스냅샷 반환. skill_reload 의 before/after diff 용.
 * 메뉴 빌드와 같은 우선순위(agent override shared)로 dedupe.
 */
export function snapshotSkills(
  agentSkillsDir: string,
  sharedSkillsDir?: string,
): SkillMenuSnapshotEntry[] {
  const agent = discoverSkills(agentSkillsDir);
  const shared = sharedSkillsDir ? discoverSkills(sharedSkillsDir) : [];
  return snapshotFromDiscovered(agent, shared);
}

function snapshotFromDiscovered(
  agent: DiscoveredSkill[],
  shared: DiscoveredSkill[],
): SkillMenuSnapshotEntry[] {
  const byName = new Map<string, SkillMenuSnapshotEntry>();
  for (const it of agent) {
    byName.set(it.skill.meta.name, {
      name: it.skill.meta.name,
      description: it.skill.meta.description ?? '',
    });
  }
  for (const it of shared) {
    if (!byName.has(it.skill.meta.name)) {
      byName.set(it.skill.meta.name, {
        name: it.skill.meta.name,
        description: it.skill.meta.description ?? '',
      });
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function rememberSkillMenuSnapshot(
  agentSkillsDir: string,
  sharedSkillsDir: string | undefined,
  snapshot: SkillMenuSnapshotEntry[],
): void {
  lastSnapshotByDirs.set(
    snapshotKey(agentSkillsDir, sharedSkillsDir),
    snapshot.map(s => ({ ...s })),
  );
}
