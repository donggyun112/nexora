import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseSkillFile,
  loadSkillsFromDir,
  loadSkills,
  SkillRegistry,
  SkillCreator,
} from '../index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-skills-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseSkillFile', () => {
  it('parses a valid SKILL.md', () => {
    const content = `---
name: test-skill
description: A test skill
tags: [test, example]
version: 2
author: agent
---

# Test Skill

## Steps
1. Do something
2. Do something else`;

    const skill = parseSkillFile(content, '/test/SKILL.md');
    expect(skill.meta.name).toBe('test-skill');
    expect(skill.meta.description).toBe('A test skill');
    expect(skill.meta.tags).toEqual(['test', 'example']);
    expect(skill.meta.version).toBe(2);
    expect(skill.meta.author).toBe('agent');
    expect(skill.body).toContain('# Test Skill');
    expect(skill.source).toBe('/test/SKILL.md');
  });

  it('throws on missing frontmatter', () => {
    expect(() => parseSkillFile('# No frontmatter', '/test')).toThrow(/no frontmatter/);
  });

  it('throws on missing name', () => {
    const content = `---
description: no name
---

body`;
    expect(() => parseSkillFile(content, '/test')).toThrow(/missing required field "name"/);
  });

  it('parses allowed-tools and platforms', () => {
    const content = `---
name: with-tools
description: Has tools
tags: [test]
allowed-tools: [read, grep, exec]
platforms: [macos, linux]
version: 1
author: system
---

body`;

    const skill = parseSkillFile(content, '/test');
    expect(skill.meta.allowedTools).toEqual(['read', 'grep', 'exec']);
    expect(skill.meta.platforms).toEqual(['macos', 'linux']);
  });
});

describe('loadSkillsFromDir', () => {
  it('loads skills from subdirectories with SKILL.md', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: my-skill
description: From dir
tags: [test]
version: 1
author: system
---

body`, 'utf-8');

    const skills = await loadSkillsFromDir(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].meta.name).toBe('my-skill');
  });

  it('loads flat .md files as skills', async () => {
    fs.writeFileSync(path.join(tmpDir, 'flat.md'), `---
name: flat-skill
description: Flat file
tags: []
version: 1
author: system
---

body`, 'utf-8');

    const skills = await loadSkillsFromDir(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].meta.name).toBe('flat-skill');
  });

  it('returns empty for non-existent directory', async () => {
    const skills = await loadSkillsFromDir('/nonexistent');
    expect(skills).toEqual([]);
  });
});

describe('loadSkills (multi-source)', () => {
  it('later directories override earlier by name', async () => {
    const dir1 = path.join(tmpDir, 'builtin');
    const dir2 = path.join(tmpDir, 'custom');
    fs.mkdirSync(dir1);
    fs.mkdirSync(dir2);

    fs.writeFileSync(path.join(dir1, 'skill.md'), `---
name: shared
description: v1
tags: []
version: 1
author: system
---
v1 body`, 'utf-8');

    fs.writeFileSync(path.join(dir2, 'skill.md'), `---
name: shared
description: v2
tags: []
version: 2
author: agent
---
v2 body`, 'utf-8');

    const skills = await loadSkills(dir1, dir2);
    expect(skills).toHaveLength(1);
    expect(skills[0].meta.description).toBe('v2');
  });
});

describe('SkillRegistry', () => {
  it('registers and retrieves skills', () => {
    const registry = new SkillRegistry();
    const skill = parseSkillFile(`---
name: test
description: Test skill
tags: [test]
version: 1
author: system
---
body`, '/test');

    registry.register(skill);
    expect(registry.get('test')).toBe(skill);
    expect(registry.list()).toHaveLength(1);
  });

  it('searches by keyword', () => {
    const registry = new SkillRegistry();
    registry.registerAll([
      parseSkillFile(`---\nname: code-review\ndescription: Review code quality\ntags: [code, review]\nversion: 1\nauthor: system\n---\nbody`, '/a'),
      parseSkillFile(`---\nname: debugging\ndescription: Debug and fix bugs\ntags: [debug, fix]\nversion: 1\nauthor: system\n---\nbody`, '/b'),
    ]);

    const results = registry.search('review code');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].skill.meta.name).toBe('code-review');
    expect(results[0].score).toBeGreaterThan(0.3);
  });

  it('formatCatalogForPrompt generates XML catalog', () => {
    const registry = new SkillRegistry();
    registry.register(parseSkillFile(`---\nname: test\ndescription: Test\ntags: []\nversion: 1\nauthor: system\n---\nbody`, '/test'));

    const catalog = registry.formatCatalogForPrompt(registry.list() as any);
    expect(catalog).toContain('<available_skills>');
    expect(catalog).toContain('<name>test</name>');
    expect(catalog).toContain('<location>/test</location>');
  });

  it('filters by tag', () => {
    const registry = new SkillRegistry();
    registry.registerAll([
      parseSkillFile(`---\nname: a\ndescription: A\ntags: [code]\nversion: 1\nauthor: system\n---\nbody`, '/a'),
      parseSkillFile(`---\nname: b\ndescription: B\ntags: [debug]\nversion: 1\nauthor: system\n---\nbody`, '/b'),
    ]);

    expect(registry.filterByTag('code')).toHaveLength(1);
    expect(registry.filterByTag('code')[0].meta.name).toBe('a');
  });
});

describe('SkillCreator', () => {
  it('creates a SKILL.md file', async () => {
    const creator = new SkillCreator({ outputDir: tmpDir });
    const skill = await creator.create({
      taskDescription: 'Deploy to production',
      steps: ['Build the project', 'Run tests', 'Push to registry'],
      toolsUsed: ['exec'],
      tags: ['deploy', 'ops'],
    });

    expect(skill.meta.name).toBe('deploy-to-production');
    expect(skill.meta.author).toBe('agent');
    expect(skill.body).toContain('Deploy to production');
    expect(skill.body).toContain('Build the project');

    // Verify file exists
    expect(fs.existsSync(skill.source)).toBe(true);
  });
});
