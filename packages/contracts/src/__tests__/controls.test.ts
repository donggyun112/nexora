import { describe, expect, it } from 'vitest';
import {
  composePreToolUse,
  continueDecision,
  denyDecision,
  suspendDecision,
  suspendEnvelope,
  type PreToolUse,
  type SuspendRequest,
  type ToolGateInfo,
} from '../controls.js';
import { errorResult } from '../tool.js';

const info: ToolGateInfo = { call: { callId: 'c1', name: 'write', input: {} } };

const ask = (question: string): SuspendRequest => ({
  topic: 'handraise.human.default',
  payload: { question },
});

/** Records that it ran, then answers with a fixed decision. */
const stage = (decision: Awaited<ReturnType<PreToolUse>>, ran: string[], id: string): PreToolUse => {
  return async () => {
    ran.push(id);
    return decision;
  };
};

describe('composePreToolUse', () => {
  it('continues when no stage objects', async () => {
    const ran: string[] = [];
    const gate = composePreToolUse(
      stage(continueDecision(), ran, 'a'),
      stage(continueDecision(), ran, 'b'),
    );
    expect(await gate(info)).toEqual({ kind: 'continue' });
    expect(ran).toEqual(['a', 'b']);
  });

  it('short-circuits on deny', async () => {
    const ran: string[] = [];
    const gate = composePreToolUse(
      stage(denyDecision(errorResult('nope')), ran, 'a'),
      stage(continueDecision(), ran, 'b'),
    );
    expect(await gate(info)).toEqual({ kind: 'deny', result: { type: 'error', message: 'nope' } });
    expect(ran).toEqual(['a']);
  });

  it('keeps evaluating after a suspend so a later deny still wins', async () => {
    const ran: string[] = [];
    const gate = composePreToolUse(
      stage(suspendDecision(ask('q1')), ran, 'a'),
      stage(denyDecision(errorResult('nope')), ran, 'b'),
    );
    expect(await gate(info)).toEqual({ kind: 'deny', result: { type: 'error', message: 'nope' } });
    expect(ran).toEqual(['a', 'b']);
  });

  it('returns the first suspend when nothing denies', async () => {
    const ran: string[] = [];
    const gate = composePreToolUse(
      stage(suspendDecision(ask('q1')), ran, 'a'),
      stage(suspendDecision(ask('q2')), ran, 'b'),
    );
    expect(await gate(info)).toEqual({ kind: 'suspend', request: ask('q1') });
    expect(ran).toEqual(['a', 'b']);
  });
});

describe('suspendEnvelope', () => {
  it('publishes under the pendingId so a reply can correlate back to the park', () => {
    const env = suspendEnvelope('pending-7', ask('approve?'), 'tenant-A');

    // metadata.replyTo on the answer is set to this id — the park is found by it.
    expect(env.id).toBe('pending-7');
    expect(env.topic).toBe('handraise.human.default');
    expect(env.type).toBe('request');
    expect(env.payload).toEqual({ question: 'approve?', pendingId: 'pending-7' });
    expect(env.metadata.tenantId).toBe('tenant-A');
    expect(env.metadata.traceId).toBeTruthy();
    expect(env.metadata.spanId).toBeTruthy();
    expect(env.metadata.conversationId).toBeTruthy();
    expect(env.metadata.timestamp).toBeGreaterThan(0);
  });
});
