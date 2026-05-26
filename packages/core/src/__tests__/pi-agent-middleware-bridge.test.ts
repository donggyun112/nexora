import { describe, it, expect, vi } from 'vitest';
import { middlewaresToAgentLoopConfig } from '../pi-agent/middleware-bridge.js';
import type { AgentMiddleware } from '../middleware.js';

describe('middlewaresToAgentLoopConfig', () => {
  it('forwards beforeToolCall to pi hook with translated context', async () => {
    const beforeToolCall = vi.fn();
    const mw: AgentMiddleware = { name: 't', beforeToolCall };
    const out = middlewaresToAgentLoopConfig([mw]);

    expect(out.hooks.beforeToolCall).toBeDefined();
    await out.hooks.beforeToolCall!({
      assistantMessage: {} as never,
      toolCall: { type: 'toolCall', id: 'c1', name: 'search', arguments: { q: 'x' } } as never,
      args: { q: 'x' },
      context: {} as never,
    });

    expect(beforeToolCall).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'search',
      callId: 'c1',
      input: { q: 'x' },
    }));
  });

  it('forwards afterToolCall to pi hook with translated context', async () => {
    const afterToolCall = vi.fn();
    const mw: AgentMiddleware = { name: 't', afterToolCall };
    const out = middlewaresToAgentLoopConfig([mw]);

    expect(out.hooks.afterToolCall).toBeDefined();
    await out.hooks.afterToolCall!({
      assistantMessage: {} as never,
      toolCall: { type: 'toolCall', id: 'c1', name: 'search', arguments: {} } as never,
      args: {},
      result: { content: [{ type: 'text', text: 'OK' }], details: undefined } as never,
      isError: false,
      context: {} as never,
    });

    expect(afterToolCall).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'search',
      callId: 'c1',
      isError: false,
      result: { type: 'text', text: 'OK' },
    }));
  });

  it('afterToolCall with no text content yields empty-string text result', async () => {
    const afterToolCall = vi.fn();
    const mw: AgentMiddleware = { name: 't', afterToolCall };
    const out = middlewaresToAgentLoopConfig([mw]);

    await out.hooks.afterToolCall!({
      assistantMessage: {} as never,
      toolCall: { type: 'toolCall', id: 'c1', name: 'search', arguments: {} } as never,
      args: {},
      result: { content: [], details: undefined } as never,
      isError: false,
      context: {} as never,
    });

    expect(afterToolCall).toHaveBeenCalledWith(expect.objectContaining({
      result: { type: 'text', text: '' },
    }));
  });

  it('runBeforeExecution invokes beforeExecution then onSessionStart in registration order', async () => {
    const calls: string[] = [];
    const mwA: AgentMiddleware = {
      name: 'A',
      beforeExecution: async () => { calls.push('A.before'); },
      onSessionStart: async () => { calls.push('A.start'); },
    };
    const mwB: AgentMiddleware = {
      name: 'B',
      beforeExecution: async () => { calls.push('B.before'); },
    };
    const out = middlewaresToAgentLoopConfig([mwA, mwB]);
    await out.runBeforeExecution({ prompt: 'hi' });
    expect(calls).toEqual(['A.before', 'B.before', 'A.start']);
  });

  it('runAfterExecution invokes afterExecution then onSessionEnd in REVERSE order', async () => {
    const calls: string[] = [];
    const mwA: AgentMiddleware = {
      name: 'A',
      afterExecution: async () => { calls.push('A.after'); },
      onSessionEnd: async () => { calls.push('A.end'); },
    };
    const mwB: AgentMiddleware = {
      name: 'B',
      afterExecution: async () => { calls.push('B.after'); },
      onSessionEnd: async () => { calls.push('B.end'); },
    };
    const out = middlewaresToAgentLoopConfig([mwA, mwB]);
    await out.runAfterExecution({ prompt: 'hi' }, [], '');
    // afterExecution: B then A (reverse). Then onSessionEnd: B then A (reverse).
    expect(calls).toEqual(['B.after', 'A.after', 'B.end', 'A.end']);
  });

  it('returns no hooks when no middleware has the corresponding callback', () => {
    const out = middlewaresToAgentLoopConfig([{ name: 'noop' }]);
    expect(out.hooks.beforeToolCall).toBeUndefined();
    expect(out.hooks.afterToolCall).toBeUndefined();
  });

  it('returns empty config for empty middleware list', () => {
    const out = middlewaresToAgentLoopConfig([]);
    expect(out.hooks.beforeToolCall).toBeUndefined();
    expect(out.hooks.afterToolCall).toBeUndefined();
    expect(typeof out.runBeforeExecution).toBe('function');
    expect(typeof out.runAfterExecution).toBe('function');
  });

  it('propagates errors thrown by afterExecution callbacks (does not swallow)', async () => {
    const mw: AgentMiddleware = {
      name: 'm',
      afterExecution: async () => { throw new Error('boom'); },
    };
    const out = middlewaresToAgentLoopConfig([mw]);
    await expect(out.runAfterExecution({ prompt: 'q' }, [], '')).rejects.toThrow('boom');
  });

  it('passes events and finalContent through to afterExecution', async () => {
    const afterExecution = vi.fn();
    const out = middlewaresToAgentLoopConfig([{ name: 'm', afterExecution }]);
    const events = [{ type: 'text' as const, text: 'a' }];
    await out.runAfterExecution({ prompt: 'q' }, events, 'final');
    expect(afterExecution).toHaveBeenCalledWith(expect.objectContaining({
      events, finalContent: 'final',
    }));
  });
});
