import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactChannelJson } from '../artifact.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-artifact-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ArtifactChannelJson', () => {
  it('round-trip: publish → fetch → list → delete', async () => {
    const ch = new ArtifactChannelJson(tmpDir);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    const ref = await ch.publish('conv-1', 'slide-1.png', bytes, { mediaType: 'image/png' });
    expect(ref.ref).toMatch(/[0-9a-f-]{36}/);
    expect(ref.scope).toBe('conv-1');
    expect(ref.name).toBe('slide-1.png');
    expect(ref.mediaType).toBe('image/png');
    expect(ref.size).toBe(4);

    const got = await ch.fetch(ref.ref);
    expect(got).not.toBeNull();
    expect(Buffer.compare(got!, bytes)).toBe(0);

    const listed = await ch.list('conv-1');
    expect(listed).toHaveLength(1);
    expect(listed[0].ref).toBe(ref.ref);
    expect(listed[0].name).toBe('slide-1.png');

    await ch.delete(ref.ref);
    expect(await ch.fetch(ref.ref)).toBeNull();
    expect(await ch.list('conv-1')).toHaveLength(0);
  });

  it('defaults mediaType to application/octet-stream and persists meta', async () => {
    const ch = new ArtifactChannelJson(tmpDir);
    const ref = await ch.publish('conv-1', 'blob.bin', Buffer.from('x'), {
      meta: { producer: 'image-gen-agent' },
    });
    expect(ref.mediaType).toBe('application/octet-stream');
    const listed = await ch.list('conv-1');
    expect(listed[0].meta).toEqual({ producer: 'image-gen-agent' });
  });

  it('list isolates by scope', async () => {
    const ch = new ArtifactChannelJson(tmpDir);
    await ch.publish('conv-a', 'a.bin', Buffer.from('a'));
    await ch.publish('conv-b', 'b.bin', Buffer.from('b'));
    expect(await ch.list('conv-a')).toHaveLength(1);
    expect((await ch.list('conv-a'))[0].name).toBe('a.bin');
  });

  it('fetch returns null for unknown or malformed ref', async () => {
    const ch = new ArtifactChannelJson(tmpDir);
    expect(await ch.fetch('does-not-exist')).toBeNull();
    expect(await ch.fetch('../escape')).toBeNull();
  });

  it('cleanup removes only expired artifacts (deterministic via now)', async () => {
    const ch = new ArtifactChannelJson(tmpDir);
    const expiring = await ch.publish('conv-1', 'tmp.bin', Buffer.from('1'), { ttlMs: 1000 });
    const permanent = await ch.publish('conv-1', 'keep.bin', Buffer.from('2'));

    const before = expiring.createdAt + 500;
    expect(await ch.cleanup(before)).toBe(0);
    expect(await ch.fetch(expiring.ref)).not.toBeNull();

    const after = expiring.createdAt + 1500;
    expect(await ch.cleanup(after)).toBe(1);
    expect(await ch.fetch(expiring.ref)).toBeNull();
    expect(await ch.fetch(permanent.ref)).not.toBeNull();
  });

  it('describeBackend reports dev json-file', async () => {
    const ch = new ArtifactChannelJson(tmpDir);
    expect(ch.describeBackend()).toEqual({
      name: 'json-file', type: 'dev', durable: true, multiProcess: false,
    });
  });
});
