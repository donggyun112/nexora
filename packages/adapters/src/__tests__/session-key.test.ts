import { describe, it, expect } from 'vitest';
import { buildSessionKey, isSharedSession } from '../session-key.js';

describe('buildSessionKey', () => {
  it('builds a DM key with chat_id', () => {
    const key = buildSessionKey({
      platform: 'discord',
      chatType: 'dm',
      chatId: 'dm-channel',
      userId: 'user-1',
    });
    expect(key).toBe('agent:main:discord:dm:dm-channel');
  });

  it('appends thread_id for threaded DMs', () => {
    const key = buildSessionKey({
      platform: 'discord',
      chatType: 'dm',
      chatId: 'dm-channel',
      threadId: 'thread-9',
      userId: 'user-1',
    });
    expect(key).toBe('agent:main:discord:dm:dm-channel:thread-9');
  });

  it('falls back to platform-only for a DM with no identifiers', () => {
    expect(buildSessionKey({ platform: 'discord', chatType: 'dm' })).toBe(
      'agent:main:discord:dm',
    );
  });

  it('isolates group sessions per user by default', () => {
    const key = buildSessionKey({
      platform: 'discord',
      chatType: 'channel',
      chatId: 'ch-1',
      userId: 'user-1',
    });
    expect(key).toBe('agent:main:discord:channel:ch-1:user-1');
  });

  it('shares group sessions when groupSessionsPerUser=false', () => {
    const key = buildSessionKey(
      {
        platform: 'discord',
        chatType: 'channel',
        chatId: 'ch-1',
        userId: 'user-1',
      },
      { groupSessionsPerUser: false },
    );
    expect(key).toBe('agent:main:discord:channel:ch-1');
  });

  it('shares thread sessions by default (no user suffix)', () => {
    const key = buildSessionKey({
      platform: 'discord',
      chatType: 'channel',
      chatId: 'ch-1',
      threadId: 'th-9',
      userId: 'user-1',
    });
    expect(key).toBe('agent:main:discord:channel:ch-1:th-9');
  });

  it('isolates threads per user when threadSessionsPerUser=true', () => {
    const key = buildSessionKey(
      {
        platform: 'discord',
        chatType: 'channel',
        chatId: 'ch-1',
        threadId: 'th-9',
        userId: 'user-1',
      },
      { threadSessionsPerUser: true },
    );
    expect(key).toBe('agent:main:discord:channel:ch-1:th-9:user-1');
  });

  it('honors custom namespace', () => {
    const key = buildSessionKey(
      { platform: 'discord', chatType: 'dm', chatId: 'c' },
      { namespace: 'tenantA' },
    );
    expect(key).toBe('tenantA:discord:dm:c');
  });

  it('treats DMs as never shared', () => {
    expect(
      isSharedSession({ platform: 'discord', chatType: 'dm', chatId: 'c' }),
    ).toBe(false);
  });

  it('treats threads as shared by default but isolated when configured', () => {
    const src = {
      platform: 'discord' as const,
      chatType: 'channel' as const,
      chatId: 'c',
      threadId: 't',
    };
    expect(isSharedSession(src)).toBe(true);
    expect(isSharedSession(src, { threadSessionsPerUser: true })).toBe(false);
  });

  it('treats group rooms as isolated by default but shared when configured', () => {
    const src = {
      platform: 'discord' as const,
      chatType: 'channel' as const,
      chatId: 'c',
    };
    expect(isSharedSession(src)).toBe(false);
    expect(isSharedSession(src, { groupSessionsPerUser: false })).toBe(true);
  });
});
