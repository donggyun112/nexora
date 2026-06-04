import { describe, expect, it } from 'vitest';
import { suspendResult, type ToolResult } from '../tool.js';

describe('ToolResult', () => {
  it('suspendResult constructs a suspend variant', () => {
    const r: ToolResult = suspendResult('pending-123');
    expect(r).toEqual({ type: 'suspend', pendingId: 'pending-123' });
  });
});
