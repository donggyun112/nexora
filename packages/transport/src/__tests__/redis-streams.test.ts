/**
 * RedisStreamsTransport unit tests — use a FakeRedisStreams in-memory mock
 * so we can exercise XADD / XREADGROUP / XACK / consumer group semantics
 * without a real Redis instance in CI.
 *
 * This is NOT a replacement for integration tests against a real Redis —
 * those should run in a separate CI lane with `docker run redis:7`. But it
 * catches the most common regressions (serialization bugs, missing ack,
 * double-delivery within a group) without requiring a daemon.
 */

import { describe, it, expect } from 'vitest';
import { RedisStreamsTransport } from '../redis-streams.js';
import type { RedisStreamsLike } from '../redis-streams.js';
import type { MessageEnvelope } from '@nexora/contracts';

// ─── FakeRedisStreams ──────────────────────────────────────────────────────

interface StreamEntry {
  id: string;
  fields: string[];
}

interface ConsumerGroup {
  name: string;
  // Pending Entries List: delivered but not yet ACKed
  pending: Map<string, StreamEntry>;
  // Which entries each consumer has seen (for $ cursor semantics)
  lastDelivered: string; // the ID after which to deliver next
}

class FakeRedisStreams implements RedisStreamsLike {
  private readonly streams = new Map<string, StreamEntry[]>();
  private readonly groups = new Map<string, Map<string, ConsumerGroup>>(); // streamKey → groupName → group
  private nextSeq = 1;

  async xadd(key: string, _id: '*' | string, ...fieldValues: string[]): Promise<string> {
    const id = `${Date.now()}-${this.nextSeq++}`;
    if (!this.streams.has(key)) this.streams.set(key, []);
    this.streams.get(key)!.push({ id, fields: fieldValues });
    return id;
  }

  async xgroup(
    command: 'CREATE',
    key: string,
    group: string,
    _id: string,
    _mkstream?: string,
  ): Promise<unknown> {
    if (command !== 'CREATE') return null;
    if (!this.groups.has(key)) this.groups.set(key, new Map());
    const groupsForKey = this.groups.get(key)!;
    if (groupsForKey.has(group)) {
      // Mirror real Redis BUSYGROUP error so the transport's ignore-BUSYGROUP
      // logic gets exercised.
      const err = new Error('BUSYGROUP Consumer Group name already exists');
      throw err;
    }
    groupsForKey.set(group, {
      name: group,
      pending: new Map(),
      lastDelivered: '0-0',
    });
    // Create the stream if it doesn't exist (MKSTREAM)
    if (!this.streams.has(key)) this.streams.set(key, []);
    return 'OK';
  }

  async xreadgroup(
    ...args: string[]
  ): Promise<Array<[string, Array<[string, string[]]>]> | null> {
    // Parse args: GROUP g c COUNT n BLOCK ms STREAMS k1 k2 ... id1 id2 ...
    let i = 0;
    if (args[i++] !== 'GROUP') return null;
    const group = args[i++];
    const _consumer = args[i++];
    let count = 10;
    let _block = 0;
    if (args[i] === 'COUNT') { i++; count = parseInt(args[i++]!, 10); }
    if (args[i] === 'BLOCK') { i++; _block = parseInt(args[i++]!, 10); }
    if (args[i++] !== 'STREAMS') return null;
    const remaining = args.slice(i);
    const half = remaining.length / 2;
    const keys = remaining.slice(0, half);
    const ids = remaining.slice(half);

    const results: Array<[string, Array<[string, string[]]>]> = [];

    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      const id = ids[k];
      const stream = this.streams.get(key) ?? [];
      const groupInfo = this.groups.get(key)?.get(group);
      if (!groupInfo) continue;

      let entries: StreamEntry[];
      if (id === '>') {
        // Deliver NEW entries only (not in pending, not yet delivered)
        const startAfter = groupInfo.lastDelivered;
        entries = stream
          .filter(e => compareIds(e.id, startAfter) > 0)
          .slice(0, count);
        for (const e of entries) {
          groupInfo.pending.set(e.id, e);
          groupInfo.lastDelivered = e.id;
        }
      } else {
        // Not modeled — we only test the '>' path
        entries = [];
      }

      if (entries.length > 0) {
        results.push([key, entries.map(e => [e.id, e.fields])]);
      }
    }

    if (results.length === 0) {
      // Simulate BLOCK timeout: return null
      await new Promise(r => setTimeout(r, 1));
      return null;
    }
    return results;
  }

  async xack(key: string, group: string, id: string): Promise<number> {
    const groupInfo = this.groups.get(key)?.get(group);
    if (!groupInfo) return 0;
    return groupInfo.pending.delete(id) ? 1 : 0;
  }

  async xlen(key: string): Promise<number> {
    return this.streams.get(key)?.length ?? 0;
  }

  /** Test helper: inspect a group's pending entries. */
  getPending(key: string, group: string): string[] {
    return Array.from(this.groups.get(key)?.get(group)?.pending.keys() ?? []);
  }
}

function compareIds(a: string, b: string): number {
  const [aMs, aSeq] = a.split('-').map(Number);
  const [bMs, bSeq] = b.split('-').map(Number);
  if (aMs !== bMs) return aMs - bMs;
  return aSeq - bSeq;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

function makeEnvelope(topic: string, payload: unknown): MessageEnvelope {
  return {
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    topic,
    type: 'event',
    payload,
    metadata: {
      traceId: 't', spanId: 's', conversationId: 'c',
      tenantId: 'default', timestamp: Date.now(),
    },
  };
}

describe('RedisStreamsTransport', () => {
  it('describes itself as at-least-once durable with consumer groups', () => {
    const fake = new FakeRedisStreams();
    const t = new RedisStreamsTransport({
      publisher: fake,
      consumer: fake,
      streamPrefix: 'test',
    });
    const d = t.describe();
    expect(d.kind).toBe('redis-streams');
    expect(d.deliveryGuarantee).toBe('at-least-once');
    expect(d.durable).toBe(true);
    expect(d.supportsConsumerGroups).toBe(true);
  });

  it('publish XADDs to the prefixed stream key', async () => {
    const fake = new FakeRedisStreams();
    const t = new RedisStreamsTransport({
      publisher: fake, consumer: fake, streamPrefix: 'test',
    });
    await t.publish(makeEnvelope('compliance.review.requested', { pr: 1 }));
    expect(await fake.xlen('test:compliance.review.requested')).toBe(1);
    await t.close();
  });

  it('subscribeGroup delivers messages and ack() removes from PEL', async () => {
    const fake = new FakeRedisStreams();
    const t = new RedisStreamsTransport({
      publisher: fake, consumer: fake,
      streamPrefix: 'test',
      blockMs: 10, // fast test loop
      consumerName: 'test-consumer',
    });

    const received: MessageEnvelope[] = [];
    const sub = t.subscribeGroup('work.requested', 'workers', async (env, ctl) => {
      received.push(env);
      await ctl.ack();
    });

    // Publish 3 envelopes
    await t.publish(makeEnvelope('work.requested', { i: 1 }));
    await t.publish(makeEnvelope('work.requested', { i: 2 }));
    await t.publish(makeEnvelope('work.requested', { i: 3 }));

    // Let the polling loop pick them up
    await new Promise(r => setTimeout(r, 80));

    expect(received).toHaveLength(3);
    expect(received.map(e => (e.payload as { i: number }).i).sort()).toEqual([1, 2, 3]);

    // All three should be XACKed — PEL empty
    expect(fake.getPending('test:work.requested', 'workers')).toHaveLength(0);

    sub.unsubscribe();
    await t.close();
  });

  it('unacked messages remain in the PEL so they can be redelivered', async () => {
    const fake = new FakeRedisStreams();
    const t = new RedisStreamsTransport({
      publisher: fake, consumer: fake,
      streamPrefix: 'test',
      blockMs: 10,
    });

    const sub = t.subscribeGroup('flaky.work', 'workers', async (_env, _ctl) => {
      // Handler throws — no ack, message stays in PEL.
      throw new Error('handler crashed');
    });

    await t.publish(makeEnvelope('flaky.work', { n: 1 }));
    await new Promise(r => setTimeout(r, 80));

    // The entry must still be in the pending list (unacked).
    expect(fake.getPending('test:flaky.work', 'workers').length).toBeGreaterThan(0);

    sub.unsubscribe();
    await t.close();
  });

  it('close() stops the polling loop cleanly', async () => {
    const fake = new FakeRedisStreams();
    const t = new RedisStreamsTransport({
      publisher: fake, consumer: fake,
      streamPrefix: 'test', blockMs: 10,
    });
    const sub = t.subscribeGroup('x', 'g', async (_e, ctl) => { await ctl.ack(); });
    await t.close();
    sub.unsubscribe(); // safe to call after close
    // Subsequent publish should error
    await expect(t.publish(makeEnvelope('x', {}))).rejects.toThrow(/closed/);
  });
});
