import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReadTool } from '../builtin/read.js';
import type { ToolContext, ToolResult } from '@dongkseo/contracts';

let dir: string;
const ctx = (): ToolContext =>
  ({ tenantId: 't', workdir: dir, secrets: { get: async () => undefined }, logger: console } as unknown as ToolContext);

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-read-img-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('read — image files', () => {
  it('returns a vision block with raw base64 for a .png', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    fs.writeFileSync(path.join(dir, 'pic.png'), bytes);
    const read = createReadTool();
    const res = (await read.execute('1', { path: 'pic.png' }, ctx())) as Extract<ToolResult, { type: 'image' }>;
    expect(res.type).toBe('image');
    expect(res.mimeType).toBe('image/png');
    expect(res.data).toBe(bytes.toString('base64'));
  });

  it('maps jpg/jpeg/webp/gif mime types', async () => {
    const cases: [string, string][] = [
      ['a.jpg', 'image/jpeg'], ['a.jpeg', 'image/jpeg'], ['a.webp', 'image/webp'], ['a.gif', 'image/gif'],
    ];
    const read = createReadTool();
    for (const [name, mime] of cases) {
      fs.writeFileSync(path.join(dir, name), Buffer.from([1, 2, 3]));
      const res = (await read.execute('1', { path: name }, ctx())) as Extract<ToolResult, { type: 'image' }>;
      expect(res.type).toBe('image');
      expect(res.mimeType).toBe(mime);
    }
  });

  it('uppercase extension is treated as image', async () => {
    fs.writeFileSync(path.join(dir, 'P.PNG'), Buffer.from([9, 9, 9]));
    const read = createReadTool();
    const res = (await read.execute('1', { path: 'P.PNG' }, ctx())) as Extract<ToolResult, { type: 'image' }>;
    expect(res.type).toBe('image');
    expect(res.mimeType).toBe('image/png');
  });

  it('non-image files still return numbered text (unchanged)', async () => {
    fs.writeFileSync(path.join(dir, 'note.txt'), 'hello\nworld');
    const read = createReadTool();
    const res = (await read.execute('1', { path: 'note.txt' }, ctx())) as Extract<ToolResult, { type: 'text' }>;
    expect(res.type).toBe('text');
    expect(res.text).toContain('hello');
    expect(res.text).toContain('world');
  });
});
