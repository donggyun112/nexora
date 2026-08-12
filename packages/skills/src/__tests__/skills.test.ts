import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  LLMMessage,
  ToolDefinition,
  ToolDefinitionSummary,
  ToolExecutor,
  ToolResult,
} from '@dongkseo/contracts';
import {
  DirectorySkillSource,
  Skill,
  SkillRegistry,
  SkillTools,
  type SkillMetadata,
  type SkillSource,
} from '../index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-skills-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSkill(root: string, name: string, description: string, body: string): string {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'SKILL.md');
  fs.writeFileSync(file, [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'allowed-tools: [read, Bash]',
    'paths: [scripts/run.ts]',
    '---',
    '',
    body,
  ].join('\n'));
  return file;
}

class StoredSkillSource implements SkillSource {
  readonly loads: string[] = [];

  constructor(readonly skill: Skill, readonly revision = '42') {}

  async list(): Promise<readonly SkillMetadata[]> {
    return [{
      name: this.skill.name,
      description: this.skill.description,
      revision: this.revision,
    }];
  }

  async load(name: string): Promise<Skill | null> {
    this.loads.push(name);
    return name === this.skill.name ? this.skill : null;
  }
}

class EmptyTools implements ToolExecutor {
  readonly calls: string[] = [];

  list(): ToolDefinitionSummary[] { return []; }

  async execute(name: string): Promise<unknown> {
    this.calls.push(name);
    return { type: 'text', text: `ran ${name}` } satisfies ToolResult;
  }
}

class RebindableTools implements ToolExecutor {
  constructor(readonly definitions: ToolDefinition[] = []) {}

  list(): ToolDefinitionSummary[] {
    return this.definitions.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  get(name: string): ToolDefinition | undefined {
    return this.definitions.find(definition => definition.name === name);
  }

  async execute(name: string): Promise<unknown> {
    return { type: 'text', text: `ran ${name}` } satisfies ToolResult;
  }

  withTools(tools: ToolDefinition[]): ToolExecutor {
    return new RebindableTools(tools);
  }
}

describe('DirectorySkillSource', () => {
  it('discovers metadata and loads the body only by exact name', async () => {
    writeSkill(tmpDir, 'review', 'Review a change', 'SECRET ${ARGUMENTS}');
    fs.writeFileSync(path.join(tmpDir, 'not-a-skill.md'), 'ignored');
    const source = new DirectorySkillSource(tmpDir);

    const listed = await source.list();

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: 'review', description: 'Review a change' });
    expect(listed[0].revision).toMatch(/^\d+$/);
    expect(JSON.stringify(listed)).not.toContain('SECRET');

    const skill = await source.load('review');
    expect(skill?.body).toBe('SECRET ${ARGUMENTS}');
    expect(skill?.allowedTools).toEqual(['read', 'Bash']);
    expect(skill?.paths).toEqual(['scripts/run.ts']);
    expect(skill?.origin).toMatch(/^file:/);
    expect(skill?.context('PR-42')).toContain('SECRET PR-42');
    expect(skill?.context('PR-42')).toContain(`Resource base for this skill: ${path.join(tmpDir, 'review')}`);
  });

  it('ignores symlinked skill roots', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-outside-skill-'));
    try {
      writeSkill(outside, 'escaped', 'Must not escape', 'secret');
      fs.symlinkSync(path.join(outside, 'escaped'), path.join(tmpDir, 'link'));
      expect(await new DirectorySkillSource(tmpDir).list()).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('returns null when a discovered skill disappears before load', async () => {
    const file = writeSkill(tmpDir, 'review', 'Review', 'body');
    const source = new DirectorySkillSource(tmpDir);
    await source.list();
    fs.rmSync(file);
    expect(await source.load('review')).toBeNull();
  });

  it('does not treat delimiter-like body text as closing frontmatter', async () => {
    const directory = path.join(tmpDir, 'broken');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'SKILL.md'), [
      '---',
      'name: broken',
      'description: malformed',
      '---not-a-delimiter',
      'SECRET',
    ].join('\n'));

    expect(await new DirectorySkillSource(tmpDir).list()).toEqual([]);
  });
});

describe('SkillRegistry', () => {
  it('lets a later source override an earlier source', async () => {
    const user = new StoredSkillSource(new Skill('review', 'user version', 'old'));
    const project = new StoredSkillSource(new Skill('review', 'project version', 'new'));
    const registry = new SkillRegistry([user, project]);

    expect(await registry.load('review')).toMatchObject({ body: 'new' });
    expect(user.loads).toEqual([]);
    expect(project.loads).toEqual(['review']);
  });

  it('does not load source bodies while building the catalog', async () => {
    const source = new StoredSkillSource(
      new Skill('review', 'Review a change', 'SECRET FULL PROCEDURE'),
    );
    const catalog = await new SkillRegistry([source]).catalog();

    expect(catalog).toContain('review');
    expect(catalog).toContain('Review a change');
    expect(catalog).not.toContain('SECRET FULL PROCEDURE');
    expect(source.loads).toEqual([]);
  });

  it('bounds large catalogs without loading bodies', async () => {
    const sources = Array.from({ length: 50 }, (_, index) =>
      new StoredSkillSource(new Skill(`skill-${index}`, 'x'.repeat(200), `secret-${index}`)));
    const catalog = await new SkillRegistry(sources, { catalogCharBudget: 300 }).catalog();

    expect(catalog.length).toBeLessThanOrEqual(300);
    expect(catalog).toContain('more');
    expect(sources.every(source => source.loads.length === 0)).toBe(true);
  });

  it('refreshes metadata explicitly and keeps snapshot I/O-free', async () => {
    writeSkill(tmpDir, 'a', 'A', 'body a');
    const registry = new SkillRegistry([tmpDir]);
    expect((await registry.list()).map(skill => skill.name)).toEqual(['a']);
    writeSkill(tmpDir, 'b', 'B', 'body b');
    expect(registry.snapshot().map(skill => skill.name)).toEqual(['a']);
    expect((await registry.refresh()).map(skill => skill.name)).toEqual(['a', 'b']);
  });
});

describe('SkillTools', () => {
  it('owns the catalog once in the skill schema and loads context on demand', async () => {
    const source = new StoredSkillSource(
      new Skill('review', 'Review without body disclosure', 'FOLLOW THIS PROCEDURE'),
    );
    const tools = new SkillTools(new EmptyTools(), new SkillRegistry([source]));

    await tools.prepare?.([] as LLMMessage[]);
    const definition = tools.list().find(tool => tool.name === 'skill');
    expect(definition?.description.match(/Review without body disclosure/g)).toHaveLength(1);
    expect(definition?.description).not.toContain('FOLLOW THIS PROCEDURE');
    expect(source.loads).toEqual([]);

    const result = await tools.execute('skill', 's1', { skill: 'review', args: 'PR-42' }) as ToolResult;
    expect(result).toMatchObject({ type: 'text', text: 'Loaded skill review.' });
    expect(result.contextMessages?.[0].content).toContain('FOLLOW THIS PROCEDURE');
    expect(result.contextMessages?.[0].content).toContain('Arguments: PR-42');
    expect(result.contextMessages?.[0].metadata).toMatchObject({
      kind: 'skill',
      name: 'review',
    });
    expect(source.loads).toEqual(['review']);
  });

  it('delegates ordinary tools and rejects invalid skill arguments', async () => {
    const inner = new EmptyTools();
    const tools = new SkillTools(inner, new SkillRegistry([]));

    expect(await tools.execute('read', 'r1', {})).toMatchObject({ type: 'text' });
    expect(inner.calls).toEqual(['read']);
    expect(await tools.execute('skill', 's1', {})).toMatchObject({ type: 'error' });
    expect(await tools.execute('skill', 's2', { skill: 'missing' })).toMatchObject({
      type: 'error',
      message: 'unknown skill: missing',
    });
  });

  it('rejects wrapping an executor that already exposes skill', () => {
    const inner = new EmptyTools();
    inner.list = () => [{ name: 'skill', description: '', parameters: {} }];
    expect(() => new SkillTools(inner, new SkillRegistry([]))).toThrow(
      "already defines 'skill'",
    );
  });

  it('survives policy rebinding without duplicating its synthetic tool', () => {
    const tools = new SkillTools(new RebindableTools(), new SkillRegistry([]));
    const skill = tools.get('skill')!;
    const read: ToolDefinition = {
      name: 'read',
      description: 'Read a file',
      parameters: {},
      execute: async () => ({ type: 'text', text: 'ok' }),
    };

    const allowed = tools.withTools?.([read, skill]);
    expect(allowed?.list().map(tool => tool.name)).toEqual(['read', 'skill']);

    const denied = tools.withTools?.([read]);
    expect(denied?.list().map(tool => tool.name)).toEqual(['read']);
  });
});
