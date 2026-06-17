/**
 * 2-agent topic 통신 시나리오:
 *   agent-A: code.review.requested 구독 → 처리 → code.review.completed 발행
 *   agent-B: code.review.completed 구독 → 결과 확인
 */

import { describe, it, expect, vi } from 'vitest';
import { LocalTransport, createEnvelope } from '../local.js';
import type { MessageEnvelope } from '@dongkseo/contracts';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('two agents over topics', () => {
  it('agent-A processes request, agent-B receives result', async () => {
    const transport = new LocalTransport();

    // agent-A: 리뷰어 역할
    transport.subscribe('code.review.requested', async (env) => {
      const { pr } = env.payload as { pr: number };
      await transport.publish({
        id: `result-${env.id}`,
        topic: 'code.review.completed',
        type: 'result',
        payload: { pr, verdict: 'lgtm', issues: [] },
        metadata: {
          ...env.metadata,
          replyTo: env.id,
          parentSpanId: env.metadata.spanId,
          spanId: 'agent-A-span',
          sourceInstanceId: 'agent-A',
          timestamp: Date.now(),
        },
      });
    });

    // agent-B: 결과 처리 역할
    const completed = vi.fn();
    transport.subscribe('code.review.completed', async (env) => {
      completed(env);
    });

    // 외부 트리거: 리뷰 요청
    await transport.publish(createEnvelope({
      topic: 'code.review.requested',
      payload: { pr: 42 },
      metadata: { traceId: 'trace-A', tenantId: 'team-1' },
    }));

    await delay(50);

    expect(completed).toHaveBeenCalledTimes(1);
    const env = completed.mock.calls[0][0] as MessageEnvelope;
    expect(env.payload).toMatchObject({ pr: 42, verdict: 'lgtm' });
    expect(env.metadata.traceId).toBe('trace-A');
    expect(env.metadata.tenantId).toBe('team-1');
    expect(env.metadata.sourceInstanceId).toBe('agent-A');

    await transport.close();
  });

  it('multi-tenant: agent processes independent requests for different tenants', async () => {
    const transport = new LocalTransport();
    const processed: { tenantId: string; payload: unknown }[] = [];

    transport.subscribe('task.requested', async (env) => {
      processed.push({ tenantId: env.metadata.tenantId, payload: env.payload });
    });

    await transport.publish(createEnvelope({
      topic: 'task.requested',
      payload: { task: 'A' },
      metadata: { tenantId: 'tenant-1' },
    }));
    await transport.publish(createEnvelope({
      topic: 'task.requested',
      payload: { task: 'B' },
      metadata: { tenantId: 'tenant-2' },
    }));
    await delay(20);

    expect(processed).toHaveLength(2);
    expect(processed.find(p => p.tenantId === 'tenant-1')?.payload).toEqual({ task: 'A' });
    expect(processed.find(p => p.tenantId === 'tenant-2')?.payload).toEqual({ task: 'B' });

    await transport.close();
  });
});
