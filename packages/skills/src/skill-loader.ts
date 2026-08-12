/** Filesystem adapter for metadata-first skill discovery. */

import fsp from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Skill, type SkillMetadata, type SkillSource } from './types.js';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const FRONTMATTER_READ_LIMIT = 64 * 1024;

/** Directory-form SKILL.md source. Discovery reads frontmatter, not instruction bodies. */
export class DirectorySkillSource implements SkillSource {
  readonly root: string;
  private locations: Map<string, string> | null = null;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async list(): Promise<readonly SkillMetadata[]> {
    const locations = new Map<string, string>();
    const metadata = new Map<string, SkillMetadata>();
    await discover(this.root, metadata, locations);
    this.locations = locations;
    return [...metadata.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async load(name: string): Promise<Skill | null> {
    if (!this.locations) await this.list();
    const file = this.locations?.get(name);
    if (!file) return null;
    try {
      const content = await fsp.readFile(file, 'utf8');
      return parseSkill(content, file);
    } catch {
      return null;
    }
  }
}

async function discover(
  dir: string,
  metadata: Map<string, SkillMetadata>,
  locations: Map<string, string>,
): Promise<void> {
  let entries: Dirent<string>[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  const skillEntry = entries.find(entry => entry.isFile() && entry.name === 'SKILL.md');
  if (skillEntry) {
    const file = path.join(dir, skillEntry.name);
    try {
      const stat = await fsp.lstat(file, { bigint: true });
      if (!stat.isSymbolicLink()) {
        const found = await readMetadata(file, stat.mtimeNs.toString());
        metadata.set(found.name, found);
        locations.set(found.name, path.resolve(file));
      }
    } catch {
      // Malformed or concurrently removed skills are absent from this snapshot.
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    await discover(path.join(dir, entry.name), metadata, locations);
  }
}

async function readMetadata(file: string, revision: string): Promise<SkillMetadata> {
  const handle = await fsp.open(file, 'r');
  try {
    let text = '';
    let offset = 0;
    while (offset < FRONTMATTER_READ_LIMIT) {
      const buffer = Buffer.alloc(Math.min(1024, FRONTMATTER_READ_LIMIT - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) {
        const parsed = splitFrontmatter(text, true);
        if (parsed) return metadataFrom(parsed.values, file, revision);
        break;
      }
      text += buffer.toString('utf8', 0, bytesRead);
      offset += bytesRead;
      const parsed = splitFrontmatter(text, bytesRead < buffer.length);
      if (parsed) return metadataFrom(parsed.values, file, revision);
    }
    throw new Error(`SKILL.md frontmatter is missing or exceeds ${FRONTMATTER_READ_LIMIT} bytes`);
  } finally {
    await handle.close();
  }
}

function parseSkill(content: string, file: string): Skill {
  const parsed = splitFrontmatter(content, false);
  if (!parsed) throw new Error('SKILL.md has no closed YAML frontmatter');
  const metadata = metadataFrom(parsed.values, file);
  return new Skill(metadata.name, metadata.description, parsed.body.trim(), {
    origin: pathToFileURL(path.resolve(file)).href,
    resourceBase: path.dirname(path.resolve(file)),
    allowedTools: stringArray(parsed.values['allowed-tools']),
    paths: stringArray(parsed.values.paths),
  });
}

function metadataFrom(
  values: Record<string, unknown>,
  file: string,
  revision?: string,
): SkillMetadata {
  const name = String(values.name || path.basename(path.dirname(file))).trim();
  if (!NAME.test(name)) throw new Error(`invalid skill name: ${JSON.stringify(name)}`);
  return {
    name,
    description: String(values.description ?? '').trim(),
    ...(revision ? { revision } : {}),
  };
}

function splitFrontmatter(
  content: string,
  allowClosingAtEnd: boolean,
): { values: Record<string, unknown>; body: string } | null {
  const normalized = content.replaceAll('\r\n', '\n');
  const firstNewline = normalized.indexOf('\n');
  if (firstNewline < 0 || normalized.slice(0, firstNewline).trim() !== '---') return null;
  const closing = new RegExp(`\\n[ \\t]*---[ \\t]*(?:\\n${allowClosingAtEnd ? '|$' : ''})`)
    .exec(normalized.slice(firstNewline + 1));
  if (!closing || closing.index === undefined) return null;
  const end = firstNewline + 1 + closing.index;
  const bodyStart = end + closing[0].length;
  return {
    values: frontmatterValues(normalized.slice(firstNewline + 1, end).split('\n')),
    body: normalized.slice(bodyStart),
  };
}

function frontmatterValues(lines: readonly string[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  let currentList: string | null = null;
  for (const line of lines) {
    const stripped = line.trim();
    if (currentList && stripped.startsWith('- ')) {
      (values[currentList] as unknown[]).push(scalar(stripped.slice(2)));
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) {
      currentList = null;
      continue;
    }
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    if (!raw) {
      values[key] = [];
      currentList = key;
    } else {
      values[key] = scalar(raw);
      currentList = null;
    }
  }
  return values;
}

function scalar(raw: string): unknown {
  const value = raw.trim().replace(/^["']|["']$/g, '');
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    return inner ? inner.split(',').map(item => scalar(item)) : [];
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
