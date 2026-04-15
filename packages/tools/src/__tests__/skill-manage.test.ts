import { describe, it, expect } from 'vitest';
import { createSkillManageTool } from '../builtin/skill-manage.js';
import type { ToolContext } from '@nexora/contracts';

const VALID_SKILL = `---
name: test-skill
description: A test skill
tags: [test]
version: 1
author: agent
---

# Test Skill

## Steps
1. Do the thing`;

const skills = new Map<string, { name: string; description: string; author: string; content: string }>();

const tool = createSkillManageTool({
  listSkills: async () => [...skills.values()].map(s => ({ name: s.name, description: s.description, author: s.author })),
  loadSkill: async (name) => skills.get(name)?.content ?? null,
  createSkill: async (content) => {
    const nameMatch = content.match(/name:\s*(.+)/);
    const name = nameMatch?.[1]?.trim() ?? 'unknown';
    const descMatch = content.match(/description:\s*(.+)/);
    const desc = descMatch?.[1]?.trim() ?? '';
    skills.set(name, { name, description: desc, author: 'agent', content });
    return name;
  },
  patchSkill: async (name, old, newT) => {
    const skill = skills.get(name);
    if (!skill) throw new Error(`Skill "${name}" not found`);
    skill.content = skill.content.replace(old, newT);
  },
  deleteSkill: async (name) => {
    if (!skills.has(name)) throw new Error(`Skill "${name}" not found`);
    skills.delete(name);
  },
});

const ctx = {
  tenantId: 'test',
  workdir: '/tmp',
  secrets: { get: async () => undefined },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
} as unknown as ToolContext;

describe('skill_manage tool', () => {
  it('list returns empty initially', async () => {
    skills.clear();
    const result = await tool.execute('c1', { action: 'list' }, ctx);
    expect(result).toMatchObject({ type: 'text' });
    expect((result as { text: string }).text).toContain('No skills');
  });

  it('create adds a skill', async () => {
    skills.clear();
    const result = await tool.execute('c2', { action: 'create', content: VALID_SKILL }, ctx);
    expect((result as { text: string }).text).toContain('created');
    expect(skills.has('test-skill')).toBe(true);
  });

  it('list shows created skill', async () => {
    const result = await tool.execute('c3', { action: 'list' }, ctx);
    expect((result as { text: string }).text).toContain('test-skill');
  });

  it('load reads skill content', async () => {
    const result = await tool.execute('c4', { action: 'load', name: 'test-skill' }, ctx);
    expect((result as { text: string }).text).toContain('# Test Skill');
  });

  it('load returns not found for unknown', async () => {
    const result = await tool.execute('c5', { action: 'load', name: 'nope' }, ctx);
    expect((result as { text: string }).text).toContain('not found');
  });

  it('patch modifies skill content', async () => {
    const result = await tool.execute('c6', {
      action: 'patch',
      name: 'test-skill',
      old_text: 'Do the thing',
      new_text: 'Do the updated thing',
    }, ctx);
    expect((result as { text: string }).text).toContain('patched');
    expect(skills.get('test-skill')?.content).toContain('updated thing');
  });

  it('delete removes skill', async () => {
    const result = await tool.execute('c7', { action: 'delete', name: 'test-skill' }, ctx);
    expect((result as { text: string }).text).toContain('deleted');
    expect(skills.has('test-skill')).toBe(false);
  });

  it('create without content returns error', async () => {
    const result = await tool.execute('c8', { action: 'create' }, ctx);
    expect(result).toMatchObject({ type: 'error' });
  });

  it('patch without name returns error', async () => {
    const result = await tool.execute('c9', { action: 'patch', old_text: 'x', new_text: 'y' }, ctx);
    expect(result).toMatchObject({ type: 'error' });
  });
});
