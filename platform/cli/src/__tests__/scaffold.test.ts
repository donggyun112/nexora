import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scaffoldAgent } from '../scaffold.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-cli-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scaffoldAgent', () => {
  it('creates 4 files for a new agent', async () => {
    const result = await scaffoldAgent({
      name: 'dev-agent',
      outDir: path.join(tmpDir, 'dev-agent'),
    });
    expect(result.files).toHaveLength(4);
    for (const file of result.files) expect(fs.existsSync(file)).toBe(true);

    const config = fs.readFileSync(path.join(result.outDir, 'agent.config.ts'), 'utf-8');
    expect(config).toContain("name: 'dev-agent'");
    expect(config).toContain("architecture: 'react'");
    expect(config).toContain('subscribes:');

    const index = fs.readFileSync(path.join(result.outDir, 'index.ts'), 'utf-8');
    expect(index).toContain('startDevAgent');
    expect(index).toContain("from '@nexora/core'");
  });

  it('respects --arch and --tools options', async () => {
    const result = await scaffoldAgent({
      name: 'researcher',
      outDir: path.join(tmpDir, 'researcher'),
      architecture: 'react',
      tools: ['read', 'web_search'],
    });
    const config = fs.readFileSync(path.join(result.outDir, 'agent.config.ts'), 'utf-8');
    expect(config).toContain("architecture: 'react'");
    expect(config).toContain('"web_search"');
  });

  it('rejects invalid agent names', async () => {
    await expect(scaffoldAgent({ name: 'Invalid Name' })).rejects.toThrow(/Invalid agent name/);
    await expect(scaffoldAgent({ name: 'UPPERCASE' })).rejects.toThrow(/Invalid agent name/);
    await expect(scaffoldAgent({ name: '123-start' })).rejects.toThrow(/Invalid agent name/);
  });

  it('refuses to overwrite existing non-empty dir without force', async () => {
    const dir = path.join(tmpDir, 'busy');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'existing.txt'), 'x');
    await expect(scaffoldAgent({ name: 'busy', outDir: dir })).rejects.toThrow(/already exists/);
  });

  it('overwrites with force', async () => {
    const dir = path.join(tmpDir, 'force-test');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old.txt'), 'old');
    await scaffoldAgent({ name: 'force-test', outDir: dir, force: true });
    expect(fs.existsSync(path.join(dir, 'agent.config.ts'))).toBe(true);
  });
});
