import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EffectWriteFencedError } from '@dongkseo/contracts';
import { EffectLedgerJson } from '../effect-ledger.js';

let dataDir: string;
let ledger: EffectLedgerJson;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-effects-'));
  ledger = new EffectLedgerJson(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('EffectLedgerJson', () => {
  it('persists running intent and completed results across instances', async () => {
    const token = await ledger.acquire('run-1', 'worker-a', 60_000);
    expect(await ledger.start('run-1', 'call-1', token)).toBe(true);
    expect(await new EffectLedgerJson(dataDir).read('run-1', 'call-1'))
      .toEqual({ status: 'running' });

    await ledger.finish('run-1', 'call-1', { type: 'text', text: 'done' }, token);
    expect(await new EffectLedgerJson(dataDir).read('run-1', 'call-1')).toEqual({
      status: 'done',
      value: { type: 'text', text: 'done' },
    });
  });

  it('starts an effect only once', async () => {
    const token = await ledger.acquire('run-1', 'worker-a', 60_000);
    expect(await ledger.start('run-1', 'call-1', token)).toBe(true);
    expect(await ledger.start('run-1', 'call-1', token)).toBe(false);
  });

  it('contends live leases and fences an expired owner after takeover', async () => {
    const stale = await ledger.acquire('run-1', 'worker-a', 60_000);
    expect(await ledger.acquire('run-1', 'worker-b', 60_000)).toBe(0);
    await ledger.release('run-1', 'worker-a');
    const current = await ledger.acquire('run-1', 'worker-b', 60_000);

    expect(current).toBeGreaterThan(stale);
    await expect(ledger.start('run-1', 'call-1', stale))
      .rejects.toBeInstanceOf(EffectWriteFencedError);
  });

  it('fails closed on a corrupt ledger file', async () => {
    fs.writeFileSync(path.join(dataDir, 'effect-ledger.json'), '{broken', 'utf8');
    await expect(ledger.read('run-1', 'call-1')).rejects.toBeInstanceOf(SyntaxError);
  });
});
