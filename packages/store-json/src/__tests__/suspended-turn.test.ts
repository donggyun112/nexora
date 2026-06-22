import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SuspendedTurnStoreJson } from '../suspended-turn.js';
import type { SuspendedTurnState, MessageEnvelope } from '@dongkseo/contracts';

let tmpDir: string;
let store: SuspendedTurnStoreJson;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-suspended-test-'));
  store = new SuspendedTurnStoreJson(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeState(pendingId: string, status: SuspendedTurnState['status'] = 'awaiting'): SuspendedTurnState {
  const envelope: MessageEnvelope = {
    id: 'req-1',
    topic: 'task.requested',
    type: 'request',
    payload: { prompt: 'hi' },
    metadata: { traceId: 't', spanId: 's', conversationId: 'c', tenantId: 'default', timestamp: 1 },
  };
  return {
    pendingId,
    toolCallId: 'tc1',
    architectureHistory: [{ role: 'assistant', content: 'asked' }],
    envelope,
    resultTopic: 'task.completed',
    tenantId: 'default',
    createdAt: 1,
    status,
  };
}

describe('SuspendedTurnStoreJson', () => {
  it('round-trips save → load and survives a fresh store instance (durable)', async () => {
    await store.save(makeState('p1'));

    // A brand-new instance reading the same dir sees the persisted turn —
    // i.e. it would survive a process restart.
    const reopened = new SuspendedTurnStoreJson(tmpDir);
    const loaded = await reopened.load('p1');
    expect(loaded).not.toBeNull();
    expect(loaded!.toolCallId).toBe('tc1');
    expect(loaded!.envelope.id).toBe('req-1');
    expect(loaded!.architectureHistory.length).toBe(1);
  });

  it('load returns null for an unknown id', async () => {
    expect(await store.load('nope')).toBeNull();
  });

  it('delete removes the turn', async () => {
    await store.save(makeState('p1'));
    await store.delete('p1');
    expect(await store.load('p1')).toBeNull();
  });

  it('listAwaiting returns only awaiting turns', async () => {
    await store.save(makeState('p1', 'awaiting'));
    await store.save(makeState('p2', 'awaiting'));
    await store.save(makeState('p3', 'resumed'));
    const awaiting = await store.listAwaiting();
    expect(awaiting.map(s => s.pendingId).sort()).toEqual(['p1', 'p2']);
  });

  it('describeBackend reports a durable dev backend', () => {
    expect(store.describeBackend()).toMatchObject({ type: 'dev', durable: true });
  });
});
