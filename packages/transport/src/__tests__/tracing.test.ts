import { describe, it, expect } from 'vitest';
import { LocalTransport, createEnvelope } from '../local.js';
import { TracingTransport, currentTrace, withTrace } from '../tracing.js';
import type { MessageEnvelope } from '@nexora/contracts';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('TracingTransport', () => {
  it('propagates traceId from handler context to nested publish', async () => {
    const local = new LocalTransport();
    const transport = new TracingTransport(local);

    const received: MessageEnvelope[] = [];
    transport.subscribe('downstream', async (env) => {
      received.push(env);
    });

    transport.subscribe('upstream', async () => {
      // Inside handler — current trace should be set
      const trace = currentTrace();
      expect(trace).toBeDefined();
      // Publish nested message → traceId should auto-propagate
      await transport.publish(createEnvelope({
        topic: 'downstream',
        payload: { hop: 1 },
      }));
    });

    const initial = createEnvelope({
      topic: 'upstream',
      payload: { start: true },
      metadata: { traceId: 'trace-xyz', tenantId: 'tenant-1' },
    });
    await transport.publish(initial);
    await delay(50);

    expect(received).toHaveLength(1);
    expect(received[0].metadata.traceId).toBe('trace-xyz');
    // nested publish가 upstream handler 안에서 일어났으므로 parentSpanId가 채워져야 함
    expect(received[0].metadata.parentSpanId).toBeDefined();
    expect(received[0].metadata.tenantId).toBe('tenant-1');

    await transport.close();
  });

  it('withTrace runs callback in custom trace context', () => {
    let captured: string | undefined;
    withTrace(
      { traceId: 'tid', spanId: 'sid', conversationId: 'cid', tenantId: 'tenant' },
      () => {
        captured = currentTrace()?.traceId;
      },
    );
    expect(captured).toBe('tid');
  });

  it('returns undefined trace outside any handler', () => {
    expect(currentTrace()).toBeUndefined();
  });
});
