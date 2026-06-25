import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LocalTarSnapshotBackend,
  NoopSnapshotBackend,
  fingerprintRoot,
} from '../workspace-snapshot.js';

const tmpRoots: string[] = [];

async function mkTmp(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })),
  );
});

describe('LocalTarSnapshotBackend', () => {
  it('round-trips a workspace into a fresh directory after the original is gone', async () => {
    const store = await mkTmp('nexora-snap-store-');
    const source = await mkTmp('nexora-snap-src-');
    await fsp.mkdir(path.join(source, 'nested'), { recursive: true });
    await fsp.writeFile(path.join(source, 'top.txt'), 'top-content');
    await fsp.writeFile(path.join(source, 'nested', 'deep.txt'), 'deep-content');

    const backend = new LocalTarSnapshotBackend(store);
    const ref = await backend.persist('conv-1', source);

    // Simulate tmpdir loss: the original workspace root is deleted entirely.
    await fsp.rm(source, { recursive: true, force: true });

    const dest = await mkTmp('nexora-snap-dest-');
    await backend.restore(ref, dest);

    expect(await fsp.readFile(path.join(dest, 'top.txt'), 'utf8')).toBe('top-content');
    expect(await fsp.readFile(path.join(dest, 'nested', 'deep.txt'), 'utf8')).toBe(
      'deep-content',
    );
  });
});

describe('NoopSnapshotBackend', () => {
  it('never reports a ref as restorable', async () => {
    const backend = new NoopSnapshotBackend();
    expect(backend.kind).toBe('noop');
    expect(await backend.restorable('anything')).toBe(false);
  });
});

describe('fingerprintRoot', () => {
  it('is stable for identical content and changes when a file changes', async () => {
    const dir = await mkTmp('nexora-fp-');
    await fsp.mkdir(path.join(dir, 'nested'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'a.txt'), 'one');
    await fsp.writeFile(path.join(dir, 'nested', 'b.txt'), 'two');

    const first = await fingerprintRoot(dir);
    const again = await fingerprintRoot(dir);
    expect(again).toBe(first);

    await fsp.writeFile(path.join(dir, 'nested', 'b.txt'), 'changed');
    const after = await fingerprintRoot(dir);
    expect(after).not.toBe(first);
  });

  it('changes when a file is added', async () => {
    const dir = await mkTmp('nexora-fp-');
    await fsp.writeFile(path.join(dir, 'a.txt'), 'one');
    const before = await fingerprintRoot(dir);
    await fsp.writeFile(path.join(dir, 'c.txt'), 'three');
    expect(await fingerprintRoot(dir)).not.toBe(before);
  });
});
