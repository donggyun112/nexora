import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArchiveLimitError,
  UnsafeArchiveMemberError,
  safeExtractTar,
  writeTar,
} from '../safe-archive.js';

const BLOCK = 512;
const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
});

async function mkTmp(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'safe-archive-'));
  tmpDirs.push(dir);
  return dir;
}

/** Build a single valid-checksum tar header block for crafting hostile archives. */
function tarHeader(opts: { name: string; type?: string; size?: number; linkname?: string }): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(opts.name, 0, 100, 'latin1');
  h.write('0000644\0', 100, 8, 'latin1'); // mode
  h.write('0000000\0', 108, 8, 'latin1'); // uid
  h.write('0000000\0', 116, 8, 'latin1'); // gid
  h.write((opts.size ?? 0).toString(8).padStart(11, '0') + '\0', 124, 12, 'latin1');
  h.write('00000000000\0', 136, 12, 'latin1'); // mtime
  h.write(opts.type ?? '0', 156, 1, 'latin1');
  if (opts.linkname) h.write(opts.linkname, 157, 100, 'latin1');
  h.write('ustar\0', 257, 6, 'latin1');
  h.write('00', 263, 2, 'latin1');
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  return h;
}

function padData(data: Buffer): Buffer {
  const rem = data.length % BLOCK;
  return rem === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rem)]);
}

/** Assemble a hostile tar from raw (header, data) member specs. */
function craftTar(members: Array<{ name: string; type?: string; size?: number; linkname?: string; data?: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const m of members) {
    const data = m.data ?? Buffer.alloc(0);
    // `size` overrides the header size field (e.g. 0 for a PAX-sized entry) while
    // the data bytes are still written — used to reproduce PAX size handling.
    chunks.push(tarHeader({ name: m.name, type: m.type, size: m.size ?? data.length, linkname: m.linkname }));
    if (data.length > 0) chunks.push(padData(data));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

/** Encode a single PAX extended-header record ("<len> key=value\n"). */
function paxRecord(key: string, value: string): Buffer {
  const body = `${key}=${value}\n`;
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  let len = bodyBytes + 2;
  while (String(len).length + 1 + bodyBytes !== len) len = String(len).length + 1 + bodyBytes;
  return Buffer.from(`${len} ${body}`, 'utf8');
}

describe('writeTar / safeExtractTar round-trip', () => {
  it('preserves nested files and directory structure', async () => {
    const src = await mkTmp();
    await fsp.mkdir(path.join(src, 'sub', 'deep'), { recursive: true });
    await fsp.writeFile(path.join(src, 'top.txt'), 'hello');
    await fsp.writeFile(path.join(src, 'sub', 'a.txt'), 'nested');
    await fsp.writeFile(path.join(src, 'sub', 'deep', 'b.bin'), Buffer.from([0, 1, 2, 255, 254]));

    const archive = await writeTar(src);
    const dest = await mkTmp();
    await safeExtractTar(archive, dest);

    expect(await fsp.readFile(path.join(dest, 'top.txt'), 'utf8')).toBe('hello');
    expect(await fsp.readFile(path.join(dest, 'sub', 'a.txt'), 'utf8')).toBe('nested');
    expect([...(await fsp.readFile(path.join(dest, 'sub', 'deep', 'b.bin')))]).toEqual([0, 1, 2, 255, 254]);
  });

  it('preserves long paths via PAX extended headers', async () => {
    const src = await mkTmp();
    const longName = 'x'.repeat(120) + '.txt';
    await fsp.writeFile(path.join(src, longName), 'long');

    const archive = await writeTar(src);
    const dest = await mkTmp();
    await safeExtractTar(archive, dest);

    expect(await fsp.readFile(path.join(dest, longName), 'utf8')).toBe('long');
  });

  it('preserves an internal symlink and creates it last', async () => {
    const src = await mkTmp();
    await fsp.writeFile(path.join(src, 'target.txt'), 'data');
    await fsp.symlink('target.txt', path.join(src, 'link.txt'));

    const archive = await writeTar(src);
    const dest = await mkTmp();
    await safeExtractTar(archive, dest);

    const stat = await fsp.lstat(path.join(dest, 'link.txt'));
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await fsp.readFile(path.join(dest, 'link.txt'), 'utf8')).toBe('data');
  });

  it('round-trips a non-ASCII long path via PAX (byte-accurate record length)', async () => {
    const src = await mkTmp();
    const name = '한글'.repeat(40) + '.txt'; // ~240 UTF-8 bytes → forces a PAX path record
    await fsp.writeFile(path.join(src, name), 'multibyte');

    const archive = await writeTar(src);
    const dest = await mkTmp();
    await safeExtractTar(archive, dest);

    expect(await fsp.readFile(path.join(dest, name), 'utf8')).toBe('multibyte');
  });

  it('reads a file whose size comes from a PAX header and stays in sync', async () => {
    // Regression: a PAX `size` record with a zeroed header size field must not
    // desynchronize the parser (the file data still occupies a padded block).
    const dest = await mkTmp();
    const archive = craftTar([
      { name: 'PaxHeader/big.txt', type: 'x', data: paxRecord('size', '5') },
      { name: 'big.txt', type: '0', size: 0, data: Buffer.from('hello') },
      { name: 'after.txt', data: Buffer.from('AFTER') },
    ]);
    await safeExtractTar(archive, dest);
    expect(await fsp.readFile(path.join(dest, 'big.txt'), 'utf8')).toBe('hello');
    expect(await fsp.readFile(path.join(dest, 'after.txt'), 'utf8')).toBe('AFTER');
  });
});

describe('safeExtractTar rejects hostile members', () => {
  it('rejects absolute member paths', async () => {
    const dest = await mkTmp();
    await expect(safeExtractTar(craftTar([{ name: '/etc/evil', data: Buffer.from('x') }]), dest)).rejects.toBeInstanceOf(
      UnsafeArchiveMemberError,
    );
  });

  it('rejects parent-traversal member paths', async () => {
    const dest = await mkTmp();
    await expect(safeExtractTar(craftTar([{ name: '../escape', data: Buffer.from('x') }]), dest)).rejects.toBeInstanceOf(
      UnsafeArchiveMemberError,
    );
  });

  it('rejects a symlink whose target escapes the root', async () => {
    const dest = await mkTmp();
    await expect(
      safeExtractTar(craftTar([{ name: 'link', type: '2', linkname: '../../etc/passwd' }]), dest),
    ).rejects.toBeInstanceOf(UnsafeArchiveMemberError);
  });

  it('rejects an absolute symlink target', async () => {
    const dest = await mkTmp();
    await expect(
      safeExtractTar(craftTar([{ name: 'link', type: '2', linkname: '/etc/passwd' }]), dest),
    ).rejects.toBeInstanceOf(UnsafeArchiveMemberError);
  });

  it('rejects hardlink members', async () => {
    const dest = await mkTmp();
    await expect(
      safeExtractTar(craftTar([{ name: 'hard', type: '1', linkname: 'something' }]), dest),
    ).rejects.toBeInstanceOf(UnsafeArchiveMemberError);
  });

  it('rejects a file descending through a symlink parent', async () => {
    const dest = await mkTmp();
    const archive = craftTar([
      { name: 'a', type: '2', linkname: '/tmp' },
      { name: 'a/b', data: Buffer.from('escaped') },
    ]);
    await expect(safeExtractTar(archive, dest)).rejects.toBeInstanceOf(UnsafeArchiveMemberError);
  });

  it('refuses to write through a pre-existing on-disk symlink parent', async () => {
    const dest = await mkTmp();
    const outside = await mkTmp();
    // dest/link -> outside ; archive tries to write dest/link/pwned.
    await fsp.symlink(outside, path.join(dest, 'link'));
    const archive = craftTar([{ name: 'link/pwned', data: Buffer.from('x') }]);
    await expect(safeExtractTar(archive, dest)).rejects.toBeInstanceOf(UnsafeArchiveMemberError);
    await expect(fsp.stat(path.join(outside, 'pwned'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('safeExtractTar enforces resource limits', () => {
  it('rejects when member count exceeds maxMembers', async () => {
    const dest = await mkTmp();
    const archive = craftTar([
      { name: 'a.txt', data: Buffer.from('1') },
      { name: 'b.txt', data: Buffer.from('2') },
      { name: 'c.txt', data: Buffer.from('3') },
    ]);
    await expect(safeExtractTar(archive, dest, { maxMembers: 2 })).rejects.toBeInstanceOf(ArchiveLimitError);
  });

  it('rejects when extracted bytes exceed maxExtractedBytes', async () => {
    const dest = await mkTmp();
    const archive = craftTar([{ name: 'big.txt', data: Buffer.alloc(4096, 0x41) }]);
    await expect(safeExtractTar(archive, dest, { maxExtractedBytes: 1024 })).rejects.toBeInstanceOf(ArchiveLimitError);
  });
});
