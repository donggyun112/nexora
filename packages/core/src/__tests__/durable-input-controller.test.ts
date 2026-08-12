import { describe, expect, it } from 'vitest';
import { DurableInputController } from '../durable-input-controller.js';
import { MemoryEffectLedger } from '../memory-effect-ledger.js';

async function controller(ledger: MemoryEffectLedger): Promise<DurableInputController> {
  const token = await ledger.acquire('run-1', 'worker-a', 60_000);
  return new DurableInputController({
    queue: ledger,
    runId: 'run-1',
    fencingToken: token,
    renewLease: () => ledger.acquire('run-1', 'worker-a', 60_000),
  });
}

describe('DurableInputController', () => {
  it('submits idempotently and claims in arrival order', async () => {
    const ledger = new MemoryEffectLedger();
    const inputs = await controller(ledger);
    await inputs.submit('in-1', { text: 'one' });
    await inputs.submit('in-1', { text: 'replacement' });
    await inputs.submit('in-2', { text: 'two' });

    const claimed = await inputs.claim();

    expect(claimed.map(input => [input.inputId, input.value])).toEqual([
      ['in-1', { text: 'one' }],
      ['in-2', { text: 'two' }],
    ]);
    expect((await ledger.listInputs('run-1')).map(input => input.status))
      .toEqual(['claimed', 'claimed']);
  });

  it('does not return one input twice to a live attempt', async () => {
    const ledger = new MemoryEffectLedger();
    const inputs = await controller(ledger);
    await inputs.submit('in-1', { text: 'one' });

    expect(await inputs.claim()).toHaveLength(1);
    expect(await inputs.claim()).toEqual([]);
  });

  it('replays admitted input on a fresh attempt unless history represents it', async () => {
    const ledger = new MemoryEffectLedger();
    const first = await controller(ledger);
    await first.submit('in-1', { text: 'one' });
    const claimed = await first.claim();
    await first.admit(claimed);

    const replaying = await controller(ledger);
    expect((await replaying.claim()).map(input => input.inputId)).toEqual(['in-1']);

    const represented = await controller(ledger);
    expect(await represented.claim(new Set(['in-1']))).toEqual([]);
  });

  it('never revives discarded input', async () => {
    const ledger = new MemoryEffectLedger();
    const first = await controller(ledger);
    await first.submit('in-1', { text: 'secret' });
    const claimed = await first.claim();
    await first.discard(claimed);

    const next = await controller(ledger);
    expect(await next.claim()).toEqual([]);
  });
});
