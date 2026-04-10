import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonStoreProvider } from '../index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-store-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ConversationStoreJson', () => {
  it('round-trip: append → getHistory → delete', async () => {
    const { conversation } = createJsonStoreProvider(tmpDir);

    await conversation.appendMessage('conv-1', { role: 'user', content: 'hello' });
    await conversation.appendMessage('conv-1', { role: 'assistant', content: 'hi there' });

    const history = await conversation.getHistory('conv-1');
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: 'user', content: 'hello' });
    expect(history[1]).toEqual({ role: 'assistant', content: 'hi there' });

    // limit
    const limited = await conversation.getHistory('conv-1', 1);
    expect(limited).toHaveLength(1);
    expect(limited[0].content).toBe('hi there');

    // compaction
    await conversation.saveCompaction('conv-1', 'summary text');

    // delete
    await conversation.deleteConversation('conv-1');
    const empty = await conversation.getHistory('conv-1');
    expect(empty).toHaveLength(0);
  });

  it('returns empty for non-existent conversation', async () => {
    const { conversation } = createJsonStoreProvider(tmpDir);
    const history = await conversation.getHistory('non-existent');
    expect(history).toHaveLength(0);
  });
});

describe('KnowledgeStoreJson', () => {
  it('round-trip: write → read → list → append → delete', async () => {
    const { knowledge } = createJsonStoreProvider(tmpDir);

    await knowledge.write('ns1', 'topic-a', '# My Topic\n\nSome content');
    const content = await knowledge.read('ns1', 'topic-a');
    expect(content).toContain('# My Topic');

    const topics = await knowledge.list('ns1');
    expect(topics).toHaveLength(1);
    expect(topics[0].name).toBe('topic-a');
    expect(topics[0].title).toBe('My Topic');

    await knowledge.append('ns1', 'topic-a', 'More content');
    const updated = await knowledge.read('ns1', 'topic-a');
    expect(updated).toContain('More content');

    await knowledge.delete('ns1', 'topic-a');
    const deleted = await knowledge.read('ns1', 'topic-a');
    expect(deleted).toBeNull();
  });

  it('rejects invalid topic names', async () => {
    const { knowledge } = createJsonStoreProvider(tmpDir);
    await expect(knowledge.write('ns1', '../evil', 'bad')).rejects.toThrow('Invalid topic name');
  });
});

describe('ScheduleStoreJson', () => {
  it('round-trip: save → loadAll → remove', async () => {
    const { schedule } = createJsonStoreProvider(tmpDir);

    const job = {
      jobId: 'job-1',
      taskName: 'daily-report',
      cronExpression: '0 9 * * *',
      description: 'Generate daily report',
      oneShot: false,
      registeredAt: new Date().toISOString(),
    };

    await schedule.save('ns1', job);
    const jobs = await schedule.loadAll('ns1');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobId).toBe('job-1');

    // upsert
    await schedule.save('ns1', { ...job, description: 'updated' });
    const updated = await schedule.loadAll('ns1');
    expect(updated).toHaveLength(1);
    expect(updated[0].description).toBe('updated');

    await schedule.remove('ns1', 'job-1');
    const empty = await schedule.loadAll('ns1');
    expect(empty).toHaveLength(0);
  });
});

describe('ContextStoreJson', () => {
  it('round-trip: save → get', async () => {
    const { context } = createJsonStoreProvider(tmpDir);

    const ctx = {
      date: '2024-01-15',
      plan: ['task A', 'task B'],
      completedTasks: ['task C'],
      dynamicJobs: [],
    };

    await context.saveDailyContext('ns1', '2024-01-15', ctx);
    const loaded = await context.getDailyContext('ns1', '2024-01-15');
    expect(loaded).toEqual(ctx);

    const missing = await context.getDailyContext('ns1', '2024-01-16');
    expect(missing).toBeNull();
  });
});

describe('AuditStoreJson', () => {
  it('round-trip: record → query with filters', async () => {
    const { audit } = createJsonStoreProvider(tmpDir);

    await audit.record('ns1', { id: 'a1', type: 'tool_call', data: { name: 'exec' }, timestamp: 1000 });
    await audit.record('ns1', { id: 'a2', type: 'error', data: { msg: 'fail' }, timestamp: 2000 });
    await audit.record('ns1', { id: 'a3', type: 'tool_call', data: { name: 'read' }, timestamp: 3000 });

    const all = await audit.query('ns1');
    expect(all).toHaveLength(3);

    const toolCalls = await audit.query('ns1', { type: 'tool_call' });
    expect(toolCalls).toHaveLength(2);

    const since = await audit.query('ns1', { since: 2000 });
    expect(since).toHaveLength(2);

    const limited = await audit.query('ns1', { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].id).toBe('a3');
  });
});

describe('ToolContextStoreJson', () => {
  it('round-trip: recordCall → recordResult → loadContext', async () => {
    const { toolContext } = createJsonStoreProvider(tmpDir);

    await toolContext.recordCall('channel-1', 'turn-1', {
      toolCallId: 'tc-1',
      name: 'exec',
      input: { command: 'ls' },
      timestamp: 1000,
    });

    await toolContext.recordResult('channel-1', 'turn-1', {
      toolCallId: 'tc-1',
      output: 'file1.ts\nfile2.ts',
      isError: false,
      timestamp: 1001,
    });

    const records = await toolContext.loadContext('channel-1', 'turn-1');
    expect(records).toHaveLength(2);
    expect(records[0].type).toBe('call');
    expect(records[1].type).toBe('result');
  });

  it('cleanup removes old files', async () => {
    const { toolContext } = createJsonStoreProvider(tmpDir);

    await toolContext.recordCall('scope', 'turn-old', {
      toolCallId: 'tc-1',
      name: 'exec',
      input: {},
      timestamp: 1000,
    });

    // Touch the file to make it old
    const oldFile = path.join(tmpDir, 'tool-context', 'scope', 'turn-old.jsonl');
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, oldTime, oldTime);

    const deleted = await toolContext.cleanup(7);
    expect(deleted).toBe(1);
  });
});
