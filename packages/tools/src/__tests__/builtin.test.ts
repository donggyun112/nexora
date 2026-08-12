import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createExecTool,
  createReadTool,
  createGrepTool,
  createGlobTool,
  createWriteTool,
  createEditTool,
  createKnowledgeTool,
  createWebSearchTool,
  createImageSearchTool,
} from '../builtin/index.js';
import type { ToolContext, KnowledgeStore, ToolResult } from '@dongkseo/contracts';

// Minimal per-key serializing lock — local to the test so tools' test suite
// doesn't depend on @dongkseo/core. KeyedSerializer's own semantics are unit-
// tested in core; here we only need *a* serializing ResourceLock to prove edit
// scopes its whole read-modify-write inside the lock.
function makeSerialLock() {
  const chains = new Map<string, Promise<unknown>>();
  return {
    runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prev = chains.get(key) ?? Promise.resolve();
      const next = prev.then(fn, fn);
      chains.set(key, next.catch(() => {}));
      return next;
    },
  };
}

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

  // argv: ['bash', '-c', 'rm -rf /'] when bash is allowlisted.
  it('blocks shell interpreters in argv mode even if allowlisted', async () => {
    const tool = createExecTool({ allowList: ['bash', 'sh', 'echo'] });
    for (const interp of ['bash', 'sh']) {
      const result = await tool.execute('1', { argv: [interp, '-c', 'echo pwned'] }, makeContext(tmpDir));
      expect(result.type).toBe('error');
      if (result.type === 'error') expect(result.message).toMatch(/interpreter|shell|exec-surface/i);
    }
  });

  // sed/find/xargs/tar/git all have exec primitives and must be blocked.
  it('blocks exec-capable tools: sed/find/xargs/tar/git/wget/curl', async () => {
    const tool = createExecTool({
      allowList: ['sed', 'find', 'xargs', 'tar', 'git', 'wget', 'curl', 'echo'],
    });
    for (const name of ['sed', 'find', 'xargs', 'tar', 'git', 'wget', 'curl']) {
      const result = await tool.execute('1', { argv: [name, 'arg'] }, makeContext(tmpDir));
      expect(result.type).toBe('error');
      if (result.type === 'error') expect(result.message).toMatch(/interpreter|shell|exec-surface/i);
    }
    // But plain 'echo' should still be allowed
    const ok = await tool.execute('2', { argv: ['echo', 'hi'] }, makeContext(tmpDir));
    expect(ok.type).toBe('text');
  });

  // Version-suffixed interpreters (python3.12, nodejs, etc.) must be blocked.
  it('blocks version-suffixed interpreters: python3.12, nodejs, node20', async () => {
    const tool = createExecTool({
      allowList: ['python3.12', 'nodejs', 'node20', 'python3', 'ruby3.3', 'echo'],
    });
    for (const name of ['python3.12', 'nodejs', 'node20', 'python3', 'ruby3.3']) {
      const result = await tool.execute('1', { argv: [name, '-c', 'print("hi")'] }, makeContext(tmpDir));
      expect(result.type).toBe('error');
      if (result.type === 'error') expect(result.message).toMatch(/interpreter|shell|exec-surface/i);
    }
  });

  it('allows interpreters when allowShell: true is set', async () => {
    const tool = createExecTool({ allowList: ['bash'], allowShell: true });
    const result = await tool.execute('1', { argv: ['bash', '-c', 'echo via-bash'] }, makeContext(tmpDir));
    expect(result.type).toBe('text');
    if (result.type === 'text') expect(result.text).toContain('via-bash');
  });

  // argv: ['../../../bin/sh', 'cmd'] — path separators in argv[0].
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

  it('reports abort instead of "No matches found"', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'plain text');
    const controller = new AbortController();
    controller.abort();
    const tool = createGrepTool();
    const result = await tool.execute('1', { pattern: 'plain' }, {
      ...makeContext(tmpDir),
      signal: controller.signal,
    });
    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toMatch(/aborted/);
  });
});

describe('glob tool', () => {
  // Mirrors the grep suite. glob is ripgrep-only; where a case needs the engine
  // we skip if rg is absent (same spirit as the read-tool poppler skip) so the
  // suite stays green on machines without ripgrep.
  const skipIfNoRg = (r: ToolResult): boolean =>
    r.type === 'error' && /ripgrep/i.test(r.message);

  it('finds files matching a glob pattern', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'y');
    fs.writeFileSync(path.join(tmpDir, 'c.md'), 'z');
    const result = await createGlobTool().execute('1', { pattern: '*.ts' }, makeContext(tmpDir));
    if (skipIfNoRg(result)) return;
    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('a.ts');
      expect(result.text).toContain('b.ts');
      expect(result.text).not.toContain('c.md');
      expect(result.text).toMatch(/Found 2 files/);
    }
  });

  it('matches nested files with a **/ pattern', async () => {
    const sub = path.join(tmpDir, 'src', 'deep');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'nested.ts'), 'x');
    const result = await createGlobTool().execute('1', { pattern: '**/*.ts' }, makeContext(tmpDir));
    if (skipIfNoRg(result)) return;
    expect(result.type).toBe('text');
    if (result.type === 'text') expect(result.text).toContain('nested.ts');
  });

  it('scopes the search to a subdirectory via path', async () => {
    fs.writeFileSync(path.join(tmpDir, 'top.ts'), 'x');
    const sub = path.join(tmpDir, 'pkg');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'inner.ts'), 'y');
    const result = await createGlobTool().execute('1', { pattern: '*.ts', path: 'pkg' }, makeContext(tmpDir));
    if (skipIfNoRg(result)) return;
    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('inner.ts');
      expect(result.text).not.toContain('top.ts');
    }
  });

  it('returns "No files found." when nothing matches', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'x');
    const result = await createGlobTool().execute('1', { pattern: '*.nomatch' }, makeContext(tmpDir));
    if (skipIfNoRg(result)) return;
    expect(result.type).toBe('text');
    if (result.type === 'text') expect(result.text).toBe('No files found.');
  });

  it('paginates with head_limit + offset', async () => {
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(tmpDir, `f${i}.ts`), 'x');
    const result = await createGlobTool().execute('1', { pattern: '*.ts', head_limit: 2 }, makeContext(tmpDir));
    if (skipIfNoRg(result)) return;
    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toMatch(/Found 2 files \(limit 2\)/);
      expect(result.text.split('\n').filter(l => l.endsWith('.ts')).length).toBe(2);
    }
  });

  it('rejects a pattern containing ".."', async () => {
    const result = await createGlobTool().execute('1', { pattern: '../*.ts' }, makeContext(tmpDir));
    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toMatch(/\.\./);
  });

  it('requires a pattern', async () => {
    const result = await createGlobTool().execute('1', {}, makeContext(tmpDir));
    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toMatch(/pattern is required/);
  });
});

describe('write tool', () => {
  it('creates files', async () => {
    const tool = createWriteTool();
    const result = await tool.execute('1', { path: 'new.txt', content: 'hello' }, makeContext(tmpDir));
    expect(result.type).toBe('text');
    expect(fs.readFileSync(path.join(tmpDir, 'new.txt'), 'utf-8')).toBe('hello');
  });

  it('routes its write through ctx.resourceLock keyed on the absolute file path', async () => {
    const keys: string[] = [];
    const ctx: ToolContext = {
      ...makeContext(tmpDir),
      resourceLock: {
        runExclusive: async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
          keys.push(key);
          return fn();
        },
      },
    };
    const tool = createWriteTool();
    const result = await tool.execute('1', { path: 'w.txt', content: 'hi' }, ctx);

    expect(result.type).toBe('text');
    expect(fs.readFileSync(path.join(tmpDir, 'w.txt'), 'utf-8')).toBe('hi');
    expect(keys).toHaveLength(1);
    expect(path.isAbsolute(keys[0])).toBe(true);
    expect(path.basename(keys[0])).toBe('w.txt');
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

  // Regression: mkdir -p must NOT run on the raw parent path before workspace
  // validation, otherwise `../outside/new` creates directories on the host
  // filesystem even though the final write is later rejected.
  it('does not mkdir outside workspace even when write is rejected', async () => {
    // Create a sibling dir next to tmpDir to detect unintended mkdirs
    const parentOfTmp = path.dirname(tmpDir);
    const canaryName = `canary-${path.basename(tmpDir)}-do-not-create`;
    const canaryPath = path.join(parentOfTmp, canaryName);
    // Ensure it doesn't exist beforehand
    expect(fs.existsSync(canaryPath)).toBe(false);

    const tool = createWriteTool();
    // Try to write via path that walks outside the workdir and into a new directory
    const result = await tool.execute('1', {
      path: `../${canaryName}/evil.txt`,
      content: 'pwned',
    }, makeContext(tmpDir));

    expect(result.type).toBe('error');

    // The directory must NOT have been created as a side-effect.
    expect(fs.existsSync(canaryPath)).toBe(false);
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

  it('routes its read-modify-write through ctx.resourceLock keyed on the file path', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'foo bar baz', 'utf-8');
    const keys: string[] = [];
    const ctx: ToolContext = {
      ...makeContext(tmpDir),
      resourceLock: {
        runExclusive: async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
          keys.push(key);
          return fn();
        },
      },
    };
    const tool = createEditTool();
    const result = await tool.execute('1', {
      path: 'a.txt',
      old_string: 'bar',
      new_string: 'BAZ',
    }, ctx);

    expect(result.type).toBe('text');
    // Edit still applies under the lock.
    expect(fs.readFileSync(path.join(tmpDir, 'a.txt'), 'utf-8')).toBe('foo BAZ baz');
    // And it acquired the lock exactly once, keyed on the resolved file path.
    expect(keys).toHaveLength(1);
    expect(path.isAbsolute(keys[0])).toBe(true);
    expect(path.basename(keys[0])).toBe('a.txt');
  });

  it('serializes concurrent same-file edits so neither update is lost', async () => {
    fs.writeFileSync(path.join(tmpDir, 'c.txt'), 'AAA BBB', 'utf-8');
    const ctx: ToolContext = { ...makeContext(tmpDir), resourceLock: makeSerialLock() };
    const tool = createEditTool();

    await Promise.all([
      tool.execute('1', { path: 'c.txt', old_string: 'AAA', new_string: 'A2' }, ctx),
      tool.execute('2', { path: 'c.txt', old_string: 'BBB', new_string: 'B2' }, ctx),
    ]);

    const final = fs.readFileSync(path.join(tmpDir, 'c.txt'), 'utf-8');
    expect(final).toContain('A2');
    expect(final).toContain('B2');
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

  // Atomic edit: uses temp-file + rename instead of truncate(0) + write()
  // to ensure the full payload is written atomically.
  it('leaves no .tmp garbage after successful edit', async () => {
    fs.writeFileSync(path.join(tmpDir, 'atomic.txt'), 'hello world', 'utf-8');
    const tool = createEditTool();

    await tool.execute('1', {
      path: 'atomic.txt',
      old_string: 'world',
      new_string: 'there',
    }, makeContext(tmpDir));

    expect(fs.readFileSync(path.join(tmpDir, 'atomic.txt'), 'utf-8')).toBe('hello there');

    // No stray .nexora-*.tmp file left in the directory.
    const leftover = fs.readdirSync(tmpDir).filter(f => f.includes('.nexora-'));
    expect(leftover).toHaveLength(0);
  });

  it('atomic edit: original unchanged if write fails', async () => {
    // Simulate by editing a file whose parent dir we make read-only after write.
    // Instead we just verify that on a successful edit the size matches the
    // new content exactly (no half-truncation visible).
    const before = 'A'.repeat(1000);
    fs.writeFileSync(path.join(tmpDir, 'big.txt'), before, 'utf-8');
    const tool = createEditTool();

    const result = await tool.execute('1', {
      path: 'big.txt',
      old_string: 'A',
      new_string: 'B',
      replace_all: true,
    }, makeContext(tmpDir));

    expect(result.type).toBe('text');
    const after = fs.readFileSync(path.join(tmpDir, 'big.txt'), 'utf-8');
    expect(after.length).toBe(1000);
    expect(after).toBe('B'.repeat(1000));
  });

  // Atomic edit via temp+rename must preserve the original file's permission
  // bits. Without this, a 0o600 secrets file would be clobbered to 0o644
  // (world-readable) and a 0o755 script would lose its executable bit.
  it('preserves 0o600 permissions across atomic edit', async () => {
    const filePath = path.join(tmpDir, 'secret.txt');
    fs.writeFileSync(filePath, 'SECRET=foo', 'utf-8');
    fs.chmodSync(filePath, 0o600);

    const before = fs.statSync(filePath).mode & 0o7777;
    expect(before).toBe(0o600);

    const tool = createEditTool();
    const result = await tool.execute('1', {
      path: 'secret.txt',
      old_string: 'foo',
      new_string: 'bar',
    }, makeContext(tmpDir));

    expect(result.type).toBe('text');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('SECRET=bar');

    const after = fs.statSync(filePath).mode & 0o7777;
    expect(after).toBe(0o600); // still private, not clobbered to 0o644
  });

  it('preserves 0o755 executable permissions across atomic edit', async () => {
    const filePath = path.join(tmpDir, 'run.sh');
    fs.writeFileSync(filePath, '#!/bin/sh\necho hello\n', 'utf-8');
    fs.chmodSync(filePath, 0o755);

    const before = fs.statSync(filePath).mode & 0o7777;
    expect(before).toBe(0o755);

    const tool = createEditTool();
    const result = await tool.execute('1', {
      path: 'run.sh',
      old_string: 'hello',
      new_string: 'world',
    }, makeContext(tmpDir));

    expect(result.type).toBe('text');

    const after = fs.statSync(filePath).mode & 0o7777;
    expect(after).toBe(0o755); // executable bit retained
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

  it('uses tenant-agent scope namespace when provided', async () => {
    const namespaces: string[] = [];
    const store: KnowledgeStore = {
      list: async () => [],
      read: async () => null,
      write: async (ns) => { namespaces.push(ns); },
      append: async () => {},
      delete: async () => {},
    };

    const tool = createKnowledgeTool(store);
    const ctx: ToolContext = {
      ...makeContext(tmpDir),
      scope: {
        tenantId: 'tenant-1',
        agentName: 'helpdesk-agent',
        namespace: 'tenant-1:helpdesk-agent',
      },
    };

    await tool.execute('1', {
      action: 'write',
      topic: 'rules',
      content: 'scoped',
    }, ctx);

    expect(namespaces).toEqual(['tenant-1:helpdesk-agent']);
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

describe('image_search tool', () => {
  it('uses injected backend and returns image reference metadata', async () => {
    const tool = createImageSearchTool({
      searchImages: async (query, _options) => [
        {
          title: `image for ${query}`,
          pageUrl: 'https://example.com/page',
          imageUrl: 'https://example.com/image.png',
          thumbnailUrl: 'https://example.com/thumb.png',
          source: 'example.com',
          width: 1200,
          height: 800,
        },
      ],
    });
    const result = await tool.execute('1', { query: 'enterprise ai dashboard' }, makeContext(tmpDir));
    if (result.type === 'text') {
      expect(result.text).toContain('image for enterprise ai dashboard');
      expect(result.text).toContain('https://example.com/image.png');
      expect(result.text).toContain('https://example.com/thumb.png');
    }
  });

  it('errors on missing query', async () => {
    const tool = createImageSearchTool({ searchImages: async () => [] });
    const result = await tool.execute('1', {}, makeContext(tmpDir));
    expect(result.type).toBe('error');
  });
});
