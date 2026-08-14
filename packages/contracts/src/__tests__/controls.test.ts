import { describe, expect, it } from 'vitest';
import {
  composeAfterToolCall,
  composeBeforeFinish,
  composeBeforeModel,
  composeOnInputs,
  composePreToolUse,
  continueDecision,
  createControlPlane,
  denyDecision,
  haltDecision,
  proceedDecision,
  suspendDecision,
  suspendEnvelope,
  type AfterToolCall,
  type BeforeFinish,
  type BeforeModel,
  type ControlContext,
  type OnInputs,
  type PreToolUse,
  type SuspendRequest,
  type ToolGateInfo,
} from '../controls.js';
import type { LLMMessage, PendingRuntimeInput } from '../agent.js';
import { errorResult } from '../tool.js';

const info: ToolGateInfo = { call: { callId: 'c1', name: 'write', input: {} } };

const ctx: ControlContext = { turn: 0, messages: [], callsMade: [], text: '', subject: '' };

const steer = (text: string): LLMMessage => ({ role: 'user', content: text });

const pending = (text: string): PendingRuntimeInput => ({ kind: 'note', message: steer(text) });

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

describe('composeOnInputs', () => {
  it('chains so each screen sees the previous screen output', async () => {
    const seen: number[] = [];
    const drop = (n: number): OnInputs => async (_c, inputs) => {
      seen.push(inputs.length);
      return inputs.slice(n);
    };
    const gate = composeOnInputs(drop(1), drop(1));
    expect(await gate(ctx, [pending('a'), pending('b'), pending('c')])).toEqual([pending('c')]);
    expect(seen).toEqual([3, 2]);
  });

  it('short-circuits on halt', async () => {
    const ran: string[] = [];
    const gate = composeOnInputs(
      async () => haltDecision('policy'),
      async (_c, inputs) => {
        ran.push('b');
        return inputs;
      },
    );
    expect(await gate(ctx, [pending('a')])).toEqual({ kind: 'halt', reason: 'policy' });
    expect(ran).toEqual([]);
  });
});

describe('composeBeforeModel', () => {
  it('accumulates steering from every source in order', async () => {
    const gate = composeBeforeModel(
      async () => proceedDecision([steer('one')]),
      async () => proceedDecision(),
      async () => proceedDecision([steer('two')]),
    );
    expect(await gate(ctx)).toEqual({ kind: 'proceed', steers: [steer('one'), steer('two')] });
  });

  // Asymmetric with composeBeforeFinish on purpose: a halt here cannot loop, so
  // the first one wins and later sources are never asked.
  it('lets the first halt win immediately', async () => {
    const ran: string[] = [];
    const source = (action: Awaited<ReturnType<BeforeModel>>, id: string): BeforeModel => {
      return async () => {
        ran.push(id);
        return action;
      };
    };
    const gate = composeBeforeModel(
      source(proceedDecision([steer('one')]), 'a'),
      source(haltDecision('aborted'), 'b'),
      source(proceedDecision([steer('three')]), 'c'),
    );
    expect(await gate(ctx)).toEqual({ kind: 'halt', reason: 'aborted' });
    expect(ran).toEqual(['a', 'b']);
  });
});

describe('composeAfterToolCall', () => {
  it('runs writers in order', async () => {
    const ran: string[] = [];
    const write = (id: string): AfterToolCall => async () => void ran.push(id);
    await composeAfterToolCall(write('a'), write('b'))(ctx, info.call, { type: 'text', text: 'ok' });
    expect(ran).toEqual(['a', 'b']);
  });

  it('propagates the first failure and stops', async () => {
    const ran: string[] = [];
    const gate = composeAfterToolCall(
      async () => {
        throw new Error('journal down');
      },
      async () => void ran.push('b'),
    );
    await expect(gate(ctx, info.call, undefined)).rejects.toThrow('journal down');
    expect(ran).toEqual([]);
  });
});

describe('composeBeforeFinish', () => {
  // Asymmetric with composeBeforeModel on purpose: refusing to finish keeps the
  // loop running, so continuing requires an explicit proceed from somebody.
  it('preserves the original reason when nobody vetoes', async () => {
    const ran: string[] = [];
    const gate = composeBeforeFinish(
      async () => {
        ran.push('a');
        return haltDecision('completed');
      },
      async () => {
        ran.push('b');
        return haltDecision('policy');
      },
    );
    expect(await gate(ctx, 'aborted')).toEqual({ kind: 'halt', reason: 'aborted' });
    expect(ran).toEqual(['a', 'b']);
  });

  it('accumulates steering across every veto instead of taking the first', async () => {
    const gate = composeBeforeFinish(
      async () => proceedDecision([steer('missing tests')]),
      async () => haltDecision('completed'),
      async () => proceedDecision([steer('missing docs')]),
    );
    expect(await gate(ctx, 'completed')).toEqual({
      kind: 'proceed',
      steers: [steer('missing tests'), steer('missing docs')],
    });
  });

  it('halts with the original reason when there are no gates', async () => {
    expect(await composeBeforeFinish()(ctx, 'tool')).toEqual({ kind: 'halt', reason: 'tool' });
  });
});

describe('createControlPlane', () => {
  it('defaults every control point permissively, except beforeFinish', async () => {
    const plane = createControlPlane();
    expect(await plane.onInputs(ctx, [pending('a')])).toEqual([pending('a')]);
    expect(await plane.beforeModel(ctx)).toEqual({ kind: 'proceed', steers: [] });
    expect(await plane.preToolUse(info)).toEqual({ kind: 'continue' });
    expect(await plane.afterToolCall(ctx, info.call, undefined)).toBeUndefined();
    // Nobody objected, so the run ends — with the reason it was given.
    expect(await plane.beforeFinish(ctx, 'aborted')).toEqual({ kind: 'halt', reason: 'aborted' });
  });

  it('denies an error answer before the onResume hook is consulted', async () => {
    let asked = false;
    const plane = createControlPlane({
      onResume: async () => {
        asked = true;
        return continueDecision();
      },
    });
    const resume = { pendingId: 'p1', answer: errorResult('timed out') };
    expect(await plane.onResume({ ...info, resume })).toEqual({
      kind: 'deny',
      result: { type: 'error', message: 'timed out' },
    });
    expect(asked).toBe(false);
  });

  it('continues an unset onResume, and consults the hook for a normal answer', async () => {
    const resume = { pendingId: 'p1', answer: { type: 'text', text: 'approved' } };
    expect(await createControlPlane().onResume({ ...info, resume })).toEqual({ kind: 'continue' });
    expect(
      await createControlPlane({ onResume: async () => denyDecision(errorResult('no')) }).onResume({
        ...info,
        resume,
      }),
    ).toEqual({ kind: 'deny', result: { type: 'error', message: 'no' } });
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
