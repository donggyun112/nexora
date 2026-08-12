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

  it('forgets only running intent and preserves completed results', async () => {
    const token = await ledger.acquire('run-1', 'worker-a', 60_000);
    await ledger.start('run-1', 'running', token);
    await ledger.start('run-1', 'done', token);
    await ledger.finish('run-1', 'done', { ok: true }, token);

    await ledger.forget('run-1', 'running', token);
    await ledger.forget('run-1', 'done', token);

    expect(await ledger.read('run-1', 'running')).toEqual({ status: 'absent' });
    expect(await ledger.read('run-1', 'done')).toEqual({
      status: 'done',
      value: { ok: true },
    });
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

  it('persists an idempotent ordered input queue across instances', async () => {
    expect(await ledger.enqueueInput('run-1', 'in-1', { text: 'one' })).toBe(true);
    expect(await ledger.enqueueInput('run-1', 'in-1', { text: 'changed' })).toBe(false);
    await ledger.enqueueInput('run-1', 'in-2', { text: 'two' });

    const reopened = new EffectLedgerJson(dataDir);
    expect(await reopened.listInputs('run-1')).toEqual([
      { inputId: 'in-1', status: 'pending', value: { text: 'one' }, sequence: 0 },
      { inputId: 'in-2', status: 'pending', value: { text: 'two' }, sequence: 1 },
    ]);
  });

  it('fences input transitions and preserves terminal states', async () => {
    const stale = await ledger.acquire('run-1', 'worker-a', 60_000);
    await ledger.enqueueInput('run-1', 'in-1', {});
    await ledger.release('run-1', 'worker-a');
    const current = await ledger.acquire('run-1', 'worker-b', 60_000);

    await expect(ledger.claimInput('run-1', 'in-1', stale))
      .rejects.toBeInstanceOf(EffectWriteFencedError);
    await ledger.claimInput('run-1', 'in-1', current);
    await ledger.discardInputs('run-1', ['in-1'], current);
    await ledger.admitInputs('run-1', ['in-1'], current);

    expect((await ledger.listInputs('run-1'))[0].status).toBe('discarded');
  });
});
