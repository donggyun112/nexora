import { describe, it, expect } from 'vitest';
import { InMemoryAgentRegistry } from '../index.js';
import { topic, type AgentCard } from '@dongkseo/contracts';

function card(name: string, overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name,
    version: '0.1.0',
    description: name,
    capabilities: [],
    subscribes: [],
    publishes: [],
    tools: [],
    architecture: 'react',
    ...overrides,
  };
}

describe('InMemoryAgentRegistry', () => {
  it('registers and retrieves agents', async () => {
    const reg = new InMemoryAgentRegistry();
    await reg.register(card('a'));
    await reg.register(card('b'));
    expect(await reg.get('a')).not.toBeNull();
    expect(await reg.get('missing')).toBeNull();
    expect((await reg.list()).map(c => c.name).sort()).toEqual(['a', 'b']);
  });

  it('finds by capability', async () => {
    const reg = new InMemoryAgentRegistry();
    await reg.register(card('reviewer', { capabilities: ['code-review', 'testing'] }));
    await reg.register(card('deployer', { capabilities: ['deploy'] }));
    const found = await reg.findByCapability('code-review');
    expect(found.map(c => c.name)).toEqual(['reviewer']);
  });

  it('finds by topic subscription with wildcards', async () => {
    const reg = new InMemoryAgentRegistry();
    await reg.register(card('reviewer', { subscribes: [topic('code.review.*')] }));
    await reg.register(card('any', { subscribes: [topic('code.#')] }));
    await reg.register(card('other', { subscribes: [topic('deploy.requested')] }));

    const found = await reg.findBySubscription('code.review.requested');
    const names = found.map(c => c.name).sort();
    expect(names).toEqual(['any', 'reviewer']);
  });

  it('unregister removes', async () => {
    const reg = new InMemoryAgentRegistry();
    await reg.register(card('a'));
    await reg.unregister('a');
    expect(await reg.get('a')).toBeNull();
  });
});
