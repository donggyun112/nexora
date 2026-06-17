import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TranscriptStoreJson } from '../transcript.js';
import type { AssistantTranscriptEntry, UserTranscriptEntry } from '@dongkseo/contracts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-transcript-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function userEntry(
  conversationId: string,
  uuid: string,
  parentUuid: string | null,
  text: string,
): UserTranscriptEntry {
  return {
    type: 'user',
    uuid,
    parentUuid,
    conversationId,
    timestamp: new Date().toISOString(),
    schemaVersion: 'v2',
    content: [{ type: 'text', text }],
  };
}

function assistantEntry(
  conversationId: string,
  uuid: string,
  parentUuid: string | null,
  text: string,
): AssistantTranscriptEntry {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    conversationId,
    timestamp: new Date().toISOString(),
    schemaVersion: 'v2',
    content: [{ type: 'text', text }],
    model: 'test-model',
  };
}

describe('TranscriptStoreJson', () => {
  it('appendEntry → getEntries round-trips entries in insertion order', async () => {
    const store = new TranscriptStoreJson(tmpDir);
    await store.appendEntry(userEntry('conv-1', 'u1', null, 'hello'));
    await store.appendEntry(assistantEntry('conv-1', 'a1', 'u1', 'hi there'));
    await store.flush();

    const entries = [];
    for await (const e of store.getEntries('conv-1')) entries.push(e);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('user');
    expect(entries[1].type).toBe('assistant');
    expect((entries[1] as AssistantTranscriptEntry).model).toBe('test-model');
  });

  it('batches concurrent appends into a single JSONL file with line-per-entry', async () => {
    const store = new TranscriptStoreJson(tmpDir);
    await Promise.all([
      store.appendEntry(userEntry('conv-2', 'u1', null, 'a')),
      store.appendEntry(userEntry('conv-2', 'u2', 'u1', 'b')),
      store.appendEntry(userEntry('conv-2', 'u3', 'u2', 'c')),
    ]);
    await store.flush();

    const fp = path.join(tmpDir, 'transcripts', 'conv-2.jsonl');
    const raw = fs.readFileSync(fp, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it('getEntries with limit yields the last N entries', async () => {
    const store = new TranscriptStoreJson(tmpDir);
    for (let i = 1; i <= 5; i++) {
      await store.appendEntry(userEntry('conv-3', `u${i}`, i === 1 ? null : `u${i - 1}`, String(i)));
    }
    await store.flush();

    const got = [];
    for await (const e of store.getEntries('conv-3', { limit: 2 })) got.push(e);
    expect(got).toHaveLength(2);
    expect(got[0].uuid).toBe('u4');
    expect(got[1].uuid).toBe('u5');
  });

  it('attachment round-trip: putAttachment → getAttachment returns identical bytes', async () => {
    const store = new TranscriptStoreJson(tmpDir);
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
    const ref = await store.putAttachment('conv-att', payload, 'image/png', 'candidate-1.png');
    expect(ref.ref).toMatch(/\.png$/);
    expect(ref.size).toBe(payload.length);

    const back = await store.getAttachment('conv-att', ref.ref);
    expect(back).not.toBeNull();
    expect(Buffer.compare(back!, payload)).toBe(0);
  });

  it('getAttachment rejects path-traversal refs', async () => {
    const store = new TranscriptStoreJson(tmpDir);
    const got = await store.getAttachment('conv-x', '../etc/passwd');
    expect(got).toBeNull();
  });

  it('returns empty for unknown conversation', async () => {
    const store = new TranscriptStoreJson(tmpDir);
    const list = [];
    for await (const e of store.getEntries('does-not-exist')) list.push(e);
    expect(list).toHaveLength(0);
  });

  it('skips malformed lines without losing the rest', async () => {
    const store = new TranscriptStoreJson(tmpDir);
    await store.appendEntry(userEntry('conv-corrupt', 'u1', null, 'ok'));
    await store.flush();
    const fp = path.join(tmpDir, 'transcripts', 'conv-corrupt.jsonl');
    fs.appendFileSync(fp, 'not json at all\n');
    await store.appendEntry(assistantEntry('conv-corrupt', 'a1', 'u1', 'also ok'));
    await store.flush();

    const entries = [];
    for await (const e of store.getEntries('conv-corrupt')) entries.push(e);
    expect(entries).toHaveLength(2);
    expect(entries[0].uuid).toBe('u1');
    expect(entries[1].uuid).toBe('a1');
  });

  it('deleteConversation removes transcript and attachments dir', async () => {
    const store = new TranscriptStoreJson(tmpDir);
    await store.appendEntry(userEntry('conv-del', 'u1', null, 'hi'));
    await store.putAttachment('conv-del', Buffer.from('x'), 'text/plain');
    await store.flush();

    await store.deleteConversation('conv-del');

    const fp = path.join(tmpDir, 'transcripts', 'conv-del.jsonl');
    const adir = path.join(tmpDir, 'transcripts', 'conv-del.attachments');
    expect(fs.existsSync(fp)).toBe(false);
    expect(fs.existsSync(adir)).toBe(false);
  });
});
