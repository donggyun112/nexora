import { describe, expect, it, expectTypeOf } from 'vitest';
import { suspendResult, type ToolResult } from '../tool.js';
import type { AgentInput, AgentEvent, RuntimeServices, LLMMessage } from '../index.js';

describe('ToolResult', () => {
  it('suspendResult constructs a suspend variant', () => {
    const r: ToolResult = suspendResult('pending-123');
    expect(r).toEqual({ type: 'suspend', pendingId: 'pending-123' });
  });
});

describe('contracts: resume types', () => {
  it('AgentInput.resumeContext is optional and carries history + tool result', () => {
    const input: AgentInput = {
      prompt: '',
      resumeContext: {
        architectureHistory: [] as LLMMessage[],
        resumedCallId: 'call-1',
        toolResult: { type: 'text', text: 'ok' } as ToolResult,
      },
    };
    expectTypeOf(input.resumeContext).toEqualTypeOf<AgentInput['resumeContext']>();
  });

  it('AgentEvent has suspended variant', () => {
    const ev: AgentEvent = { type: 'suspended', pendingId: 'p1', toolCallId: 'c1' };
    expectTypeOf(ev).toMatchTypeOf<AgentEvent>();
  });

  it('RuntimeServices.onSuspend is optional async callback', () => {
    const s = {} as RuntimeServices;
    expectTypeOf(s.onSuspend).toEqualTypeOf<RuntimeServices['onSuspend']>();
  });
});
