import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreContextLoader, currentRuntime } from '../loader.js';
import { PersonaLoader } from '../persona.js';
import { SkillLoader } from '../skills.js';
import { TenantConfigStore } from '../tenant.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-context-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function setupTree(): void {
  fs.mkdirSync(path.join(tmpDir, 'personas'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'tenants', 'tenant-A', 'personas'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'tenants', 'tenant-A', 'skills'), { recursive: true });
}

describe('PersonaLoader', () => {
  it('falls back to default persona when no file', () => {
    const loader = new PersonaLoader({ root: tmpDir });
    expect(loader.load('any-agent')).toContain('helpful');
  });

  it('loads default persona file', () => {
    setupTree();
    fs.writeFileSync(path.join(tmpDir, 'personas', 'dev.md'), 'You are a developer.');
    const loader = new PersonaLoader({ root: tmpDir });
    expect(loader.load('dev')).toBe('You are a developer.');
  });

  it('tenant override takes precedence', () => {
    setupTree();
    fs.writeFileSync(path.join(tmpDir, 'personas', 'dev.md'), 'default dev');
    fs.writeFileSync(path.join(tmpDir, 'tenants', 'tenant-A', 'personas', 'dev.md'), 'tenant-A dev');
    const loader = new PersonaLoader({ root: tmpDir });
    expect(loader.load('dev', 'tenant-A')).toBe('tenant-A dev');
    expect(loader.load('dev', 'tenant-B')).toBe('default dev');
  });
});

describe('SkillLoader', () => {
  it('returns empty when no skills dir', () => {
    const loader = new SkillLoader({ root: tmpDir });
    expect(loader.list()).toEqual([]);
    expect(loader.buildMenu()).toBe('');
  });

  it('parses frontmatter for name + description', () => {
    setupTree();
    fs.writeFileSync(
      path.join(tmpDir, 'skills', 'jira-create.md'),
      '---\nname: jira-create\ndescription: Create Jira tickets\n---\n\n# Body\n',
    );
    const loader = new SkillLoader({ root: tmpDir });
    const list = loader.list();
    expect(list).toEqual([{ name: 'jira-create', description: 'Create Jira tickets' }]);
    const menu = loader.buildMenu();
    expect(menu).toContain('Available Skills');
    expect(menu).toContain('jira-create: Create Jira tickets');
  });

  it('tenant skills merge with defaults (override by name)', () => {
    setupTree();
    fs.writeFileSync(
      path.join(tmpDir, 'skills', 'a.md'),
      '---\nname: a\ndescription: default a\n---\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'skills', 'b.md'),
      '---\nname: b\ndescription: default b\n---\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'tenants', 'tenant-A', 'skills', 'a.md'),
      '---\nname: a\ndescription: tenant a\n---\n',
    );

    const loader = new SkillLoader({ root: tmpDir });
    const tenantList = loader.list('tenant-A');
    expect(tenantList).toHaveLength(2);
    expect(tenantList.find(s => s.name === 'a')?.description).toBe('tenant a');
    expect(tenantList.find(s => s.name === 'b')?.description).toBe('default b');
  });
});

describe('TenantConfigStore', () => {
  it('returns minimal config when no file', () => {
    const store = new TenantConfigStore({ root: tmpDir });
    expect(store.load('tenant-A')).toEqual({ id: 'tenant-A' });
  });

  it('loads tenant.json', () => {
    fs.mkdirSync(path.join(tmpDir, 'tenants', 'tenant-A'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'tenants', 'tenant-A', 'tenant.json'),
      JSON.stringify({
        name: 'Team A',
        limits: { model: 'claude-haiku-4-5', maxTokens: 4096 },
        allowedToolsByAgent: { 'dev-agent': ['read', 'grep'] },
        extraContext: 'Team A is the platform team.',
      }),
    );

    const store = new TenantConfigStore({ root: tmpDir });
    const config = store.load('tenant-A');
    expect(config.name).toBe('Team A');
    expect(config.limits?.model).toBe('claude-haiku-4-5');
    expect(config.extraContext).toContain('platform team');

    const merged = store.mergedLimits('tenant-A');
    expect(merged.model).toBe('claude-haiku-4-5');
    expect(merged.maxTokens).toBe(4096);
    expect(merged.contextWindow).toBe(200_000); // default

    expect(store.allowedTools('tenant-A', 'dev-agent')).toEqual(['read', 'grep']);
    expect(store.allowedTools('tenant-A', 'other-agent')).toBeNull();
  });
});

describe('CoreContextLoader', () => {
  it('builds full system prompt with all components', async () => {
    setupTree();
    fs.writeFileSync(path.join(tmpDir, 'common.md'), '# Common\nshared rules');
    fs.writeFileSync(path.join(tmpDir, 'personas', 'dev.md'), 'You are dev.');
    fs.writeFileSync(
      path.join(tmpDir, 'skills', 'lint.md'),
      '---\nname: lint\ndescription: Run linters\n---\n',
    );
    fs.mkdirSync(path.join(tmpDir, 'tenants', 'tenant-A'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'tenants', 'tenant-A', 'tenant.json'),
      JSON.stringify({
        limits: { model: 'claude-haiku-4-5' },
        allowedToolsByAgent: { dev: ['read'] },
        extraContext: 'Tenant-A specific notes.',
      }),
    );

    const loader = new CoreContextLoader({ root: tmpDir });
    const ctx = await loader.load('tenant-A', 'dev');

    expect(ctx.tenantId).toBe('tenant-A');
    expect(ctx.systemPrompt).toContain('# Common');
    expect(ctx.systemPrompt).toContain('You are dev.');
    expect(ctx.systemPrompt).toContain('Tenant-A specific notes.');
    expect(ctx.systemPrompt).toContain('Today:');
    expect(ctx.systemPrompt).toContain('lint');
    expect(ctx.tools).toEqual(['read']);
    expect(ctx.limits.model).toBe('claude-haiku-4-5');
    expect(ctx.runtime.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('different tenants get different contexts', async () => {
    setupTree();
    fs.writeFileSync(path.join(tmpDir, 'personas', 'dev.md'), 'default dev');
    fs.writeFileSync(
      path.join(tmpDir, 'tenants', 'tenant-A', 'personas', 'dev.md'),
      'A-customized dev',
    );

    const loader = new CoreContextLoader({ root: tmpDir });
    const ctxA = await loader.load('tenant-A', 'dev');
    const ctxB = await loader.load('tenant-B', 'dev');

    expect(ctxA.persona).toBe('A-customized dev');
    expect(ctxB.persona).toBe('default dev');
  });

  it('respects overrides in load() call', async () => {
    setupTree();
    const loader = new CoreContextLoader({ root: tmpDir, defaultTools: ['read'] });
    const ctx = await loader.load('tenant-A', 'dev', {
      tools: ['exec', 'write'],
      systemPrompt: 'CUSTOM',
    });
    expect(ctx.tools).toEqual(['exec', 'write']);
    expect(ctx.systemPrompt).toBe('CUSTOM');
  });
});

describe('currentRuntime', () => {
  it('returns YYYY-MM-DD today', () => {
    const r = currentRuntime('/tmp');
    expect(r.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.workdir).toBe('/tmp');
    expect(r.thisWeek).toMatch(/^\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}$/);
  });
});
