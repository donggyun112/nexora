import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createExecTool,
  createReadTool,
  createGrepTool,
  createWriteTool,
  createEditTool,
  createKnowledgeTool,
  createWebSearchTool,
} from '../builtin/index.js';
import type { ToolContext, KnowledgeStore, ToolResult } from '@nexora/contracts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-tools-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeContext(workdir: string): ToolContext {
  return {
    tenantId: 'tenant-1',
    workdir,
    secrets: { get: async () => undefined },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

describe('exec tool', () => {
  it('refuses to run anything when allowList is missing', async () => {
    const tool = createExecTool();
    const result = await tool.execute('1', { argv: ['echo', 'hello'] }, makeContext(tmpDir));
    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toMatch(/allowList/);
  });

  it('runs argv form when executable is in allowList', async () => {
    const tool = createExecTool({ allowList: ['echo'] });
    const result = await tool.execute('1', { argv: ['echo', 'hello'] }, makeContext(tmpDir));
    expect(result.type).toBe('text');
    if (result.type === 'text') expect(result.text).toContain('hello');
  });

  it('refuses shell-string mode by default', async () => {
    const tool = createExecTool({ allowList: ['echo'] });
    const result = await tool.execute('1', { command: 'echo hi' }, makeContext(tmpDir));
    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toMatch(/disabled|argv/i);
  });

  it('allows shell-string mode when explicitly enabled', async () => {
    const tool = createExecTool({ allowShell: true });
    const result = await tool.execute('1', { command: 'echo hi' }, makeContext(tmpDir));
    expect(result.type).toBe('text');
    if (result.type === 'text') expect(result.text).toContain('hi');
  });

  it('does NOT interpolate shell metacharacters in argv form', async () => {
    const tool = createExecTool({ allowList: ['echo'] });
    const result = await tool.execute('1', { argv: ['echo', '$(whoami)'] }, makeContext(tmpDir));
    if (result.type === 'text') {
      expect(result.text).toContain('$(whoami)');
    }
  });

  it('enforces allowList rejection', async () => {
    const tool = createExecTool({ allowList: ['echo'] });
    const denied = await tool.execute('2', { argv: ['cat', '/etc/passwd'] }, makeContext(tmpDir));
    expect(denied.type).toBe('error');
    if (denied.type === 'error') expect(denied.message).toMatch(/allowList/);
  });

  // Codex re-review attack #1: argv: ['bash', '-c', 'rm -rf /'] when bash is allowlisted.
  it('blocks shell interpreters in argv mode even if allowlisted', async () => {
    const tool = createExecTool({ allowList: ['bash', 'sh', 'echo'] });
    for (const interp of ['bash', 'sh']) {
      const result = await tool.execute('1', { argv: [interp, '-c', 'echo pwned'] }, makeContext(tmpDir));
      expect(result.type).toBe('error');
      if (result.type === 'error') expect(result.message).toMatch(/interpreter|shell/i);
    }
  });

  it('allows interpreters when allowShell: true is set', async () => {
    const tool = createExecTool({ allowList: ['bash'], allowShell: true });
    const result = await tool.execute('1', { argv: ['bash', '-c', 'echo via-bash'] }, makeContext(tmpDir));
    expect(result.type).toBe('text');
    if (result.type === 'text') expect(result.text).toContain('via-bash');
  });

  // Codex re-review attack #2: argv: ['../../../bin/sh', 'cmd']
  it('rejects path separators in argv[0]', async () => {
    const tool = createExecTool({ allowList: ['echo'] });
    const cases = ['../../../bin/sh', '/usr/bin/echo', '/bin/sh', './echo', 'sub/echo'];
    for (const program of cases) {
      const result = await tool.execute('1', { argv: [program, 'x'] }, makeContext(tmpDir));
      expect(result.type).toBe('error');
      if (result.type === 'error') expect(result.message).toMatch(/separator|bare command/i);
    }
  });

  it('rejects argv[0] starting with -', async () => {
    const tool = createExecTool({ allowList: ['echo', '-x'] });
    const result = await tool.execute('1', { argv: ['-x'] }, makeContext(tmpDir));
    expect(result.type).toBe('error');
  });

  it('scrubs environment by default — secret env vars do not leak', async () => {
    process.env.NEXORA_SECRET = 'super-secret';
    try {
      const tool = createExecTool({ allowList: ['printenv'] });
      const result = await tool.execute('1', { argv: ['printenv', 'NEXORA_SECRET'] }, makeContext(tmpDir));
      if (result.type === 'text') {
        expect(result.text).not.toContain('super-secret');
      }
    } finally {
      delete process.env.NEXORA_SECRET;
    }
  });

  it('forwards explicitly allowed env vars', async () => {
    process.env.NEXORA_PUBLIC = 'visible';
    try {
      const tool = createExecTool({
        allowList: ['printenv'],
        envAllowList: ['NEXORA_PUBLIC'],
      });
      const result = await tool.execute('1', { argv: ['printenv', 'NEXORA_PUBLIC'] }, makeContext(tmpDir));
      if (result.type === 'text') expect(result.text).toContain('visible');
    } finally {
      delete process.env.NEXORA_PUBLIC;
    }
  });

  it('returns error when neither argv nor command provided', async () => {
    const tool = createExecTool({ allowList: ['echo'] });
    const result = await tool.execute('1', {}, makeContext(tmpDir));
    expect(result.type).toBe('error');
  });

  it('captures non-zero exit code in argv mode', async () => {
    const tool = createExecTool({ allowList: ['false'] });
    const result = await tool.execute('1', { argv: ['false'] }, makeContext(tmpDir));
    expect(result.type).toBe('text');
    if (result.type === 'text') expect(result.text).toContain('exit 1');
  });
});

describe('read tool', () => {
  it('reads files with line numbers', async () => {
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'line1\nline2\nline3', 'utf-8');
    const tool = createReadTool();
    const result = await tool.execute('1', { path: 'test.txt' }, makeContext(tmpDir));
    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('line1');
      expect(result.text).toContain('1\u2192');
    }
  });

  it('lists directories', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    const tool = createReadTool();
    const result = await tool.execute('1', { path: '.' }, makeContext(tmpDir));
    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('a.txt');
      expect(result.text).toContain('sub/');
    }
  });

  it('blocks paths outside workdir', async () => {
    const tool = createReadTool();
    const result = await tool.execute('1', { path: '/etc/passwd' }, makeContext(tmpDir));
    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toContain('outside');
  });

  // Regression: symlink inside workspace pointing outside used to bypass the
  // lexical startsWith() check.
  it('blocks symlink inside workspace pointing outside', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-outside-'));
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'TOP SECRET', 'utf-8');
    try {
      fs.symlinkSync(secret, path.join(tmpDir, 'evil-link'));
      const tool = createReadTool();
      const result = await tool.execute('1', { path: 'evil-link' }, makeContext(tmpDir));
      expect(result.type).toBe('error');
      if (result.type === 'error') expect(result.message).toMatch(/outside|symlink/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('respects offset/limit', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    fs.writeFileSync(path.join(tmpDir, 't.txt'), lines, 'utf-8');
    const tool = createReadTool();
    const result = await tool.execute('1', { path: 't.txt', offset: 3, limit: 2 }, makeContext(tmpDir));
    if (result.type === 'text') {
      expect(result.text).toContain('line3');
      expect(result.text).toContain('line4');
      expect(result.text).not.toContain('line5');
    }
  });
});

describe('grep tool', () => {
  it('finds matches in files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const TODO = 1;\nconst FIXME = 2;');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'console.log("ok");');
    const tool = createGrepTool();
    const result = await tool.execute('1', { pattern: 'TODO|FIXME' }, makeContext(tmpDir));
    if (result.type === 'text') {
      expect(result.text).toContain('TODO');
      expect(result.text).toContain('FIXME');
    }
  });

  it('returns "No matches found" when nothing matches', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'plain text');
    const tool = createGrepTool();
    const result = await tool.execute('1', { pattern: 'nonexistent' }, makeContext(tmpDir));
    if (result.type === 'text') expect(result.text).toBe('No matches found.');
  });
});

describe('write tool', () => {
  it('creates files', async () => {
    const tool = createWriteTool();
    const result = await tool.execute('1', { path: 'new.txt', content: 'hello' }, makeContext(tmpDir));
    expect(result.type).toBe('text');
    expect(fs.readFileSync(path.join(tmpDir, 'new.txt'), 'utf-8')).toBe('hello');
  });

  it('creates parent directories', async () => {
    const tool = createWriteTool();
    await tool.execute('1', { path: 'sub/dir/new.txt', content: 'x' }, makeContext(tmpDir));
    expect(fs.existsSync(path.join(tmpDir, 'sub/dir/new.txt'))).toBe(true);
  });

  it('blocks writes outside workdir', async () => {
    const tool = createWriteTool();
    const result = await tool.execute('1', { path: '/tmp/evil.txt', content: 'x' }, makeContext(tmpDir));
    expect(result.type).toBe('error');
  });

  // Regression: previously a symlink at the target path was followed and
  // overwrote the external file.
  it('blocks writes through a symlink pointing outside the workspace', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-outside-write-'));
    const target = path.join(outside, 'target.txt');
    fs.writeFileSync(target, 'original', 'utf-8');
    try {
      fs.symlinkSync(target, path.join(tmpDir, 'leaky.txt'));
      const tool = createWriteTool();
      const result = await tool.execute('1', {
        path: 'leaky.txt',
        content: 'pwned',
      }, makeContext(tmpDir));
      expect(result.type).toBe('error');
      if (result.type === 'error') expect(result.message).toMatch(/outside|symlink/i);
      expect(fs.readFileSync(target, 'utf-8')).toBe('original');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('blocks writes via symlinked parent directory', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-outside-parent-'));
    try {
      fs.symlinkSync(outside, path.join(tmpDir, 'escape'));
      const tool = createWriteTool();
      const result = await tool.execute('1', {
        path: 'escape/new.txt',
        content: 'x',
      }, makeContext(tmpDir));
      expect(result.type).toBe('error');
      if (result.type === 'error') expect(result.message).toMatch(/outside|symlink/i);
      expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('edit tool', () => {
  it('replaces unique string', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'foo bar baz', 'utf-8');
    const tool = createEditTool();
    const result = await tool.execute('1', {
      path: 'a.txt',
      old_string: 'bar',
      new_string: 'BAZ',
    }, makeContext(tmpDir));
    expect(result.type).toBe('text');
    expect(fs.readFileSync(path.join(tmpDir, 'a.txt'), 'utf-8')).toBe('foo BAZ baz');
  });

  it('errors on multiple matches without replace_all', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'foo foo foo', 'utf-8');
    const tool = createEditTool();
    const result = await tool.execute('1', {
      path: 'a.txt',
      old_string: 'foo',
      new_string: 'bar',
    }, makeContext(tmpDir));
    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toContain('appears 3 times');
  });

  it('replace_all replaces all occurrences', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'foo foo foo', 'utf-8');
    const tool = createEditTool();
    await tool.execute('1', {
      path: 'a.txt',
      old_string: 'foo',
      new_string: 'bar',
      replace_all: true,
    }, makeContext(tmpDir));
    expect(fs.readFileSync(path.join(tmpDir, 'a.txt'), 'utf-8')).toBe('bar bar bar');
  });

  it('errors when old_string not found', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'foo', 'utf-8');
    const tool = createEditTool();
    const result = await tool.execute('1', {
      path: 'a.txt',
      old_string: 'missing',
      new_string: 'x',
    }, makeContext(tmpDir));
    expect(result.type).toBe('error');
  });

  // Regression: editing through a symlink pointing outside the workspace
  // would have modified the external file.
  it('blocks edits through a symlink pointing outside the workspace', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-outside-edit-'));
    const target = path.join(outside, 'target.txt');
    fs.writeFileSync(target, 'foo', 'utf-8');
    try {
      fs.symlinkSync(target, path.join(tmpDir, 'leaky.txt'));
      const tool = createEditTool();
      const result = await tool.execute('1', {
        path: 'leaky.txt',
        old_string: 'foo',
        new_string: 'bar',
      }, makeContext(tmpDir));
      expect(result.type).toBe('error');
      if (result.type === 'error') expect(result.message).toMatch(/outside|symlink/i);
      expect(fs.readFileSync(target, 'utf-8')).toBe('foo');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('knowledge tool', () => {
  it('writes/reads/lists topics via store', async () => {
    const data = new Map<string, string>();
    const store: KnowledgeStore = {
      list: async () => Array.from(data.keys()).map(name => ({
        name,
        title: name,
        lineCount: 1,
      })),
      read: async (_ns, topic) => data.get(topic) ?? null,
      write: async (_ns, topic, content) => { data.set(topic, content); },
      append: async (_ns, topic, content) => {
        data.set(topic, (data.get(topic) ?? '') + '\n' + content);
      },
      delete: async (_ns, topic) => { data.delete(topic); },
    };

    const tool = createKnowledgeTool(store);
    const ctx = makeContext(tmpDir);

    const writeResult = await tool.execute('1', {
      action: 'write',
      topic: 'rules',
      content: '# Rules\nbe nice',
    }, ctx);
    expect(writeResult.type).toBe('text');

    const readResult = await tool.execute('2', { action: 'read', topic: 'rules' }, ctx);
    if (readResult.type === 'text') expect(readResult.text).toContain('be nice');

    const listResult = await tool.execute('3', { action: 'list' }, ctx);
    if (listResult.type === 'text') expect(listResult.text).toContain('rules');
  });
});

describe('web_search tool', () => {
  it('uses injected backend', async () => {
    const tool = createWebSearchTool({
      search: async (query, _options) => [
        { title: `result for ${query}`, url: 'https://example.com', snippet: 'snippet here' },
      ],
    });
    const result = await tool.execute('1', { query: 'nexora' }, makeContext(tmpDir));
    if (result.type === 'text') {
      expect(result.text).toContain('result for nexora');
      expect(result.text).toContain('https://example.com');
    }
  });

  it('errors on missing query', async () => {
    const tool = createWebSearchTool({ search: async () => [] });
    const result = await tool.execute('1', {}, makeContext(tmpDir));
    expect(result.type).toBe('error');
  });
});
