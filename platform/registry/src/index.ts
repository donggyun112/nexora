/**
 * @dongkseo/registry — AgentCard registration and lookup.
 *
 * The abstract `AgentRegistry` contract lives in `@dongkseo/contracts` (so the
 * core runtime can call it without a reverse dependency into this package).
 * This package provides the default in-memory implementation. Production
 * deployments can swap in a Redis/etcd-backed adapter by implementing the
 * same contract.
 */

import type { AgentCard, AgentRegistry, TopicString } from '@dongkseo/contracts';
import { matchTopic } from '@dongkseo/contracts';

export type { AgentRegistry } from '@dongkseo/contracts';

export class InMemoryAgentRegistry implements AgentRegistry {
  private readonly cards = new Map<string, AgentCard>();

  async register(card: AgentCard): Promise<void> {
    this.cards.set(card.name, card);
  }

  async unregister(name: string): Promise<void> {
    this.cards.delete(name);
  }

  async get(name: string): Promise<AgentCard | null> {
    return this.cards.get(name) ?? null;
  }

  async list(): Promise<AgentCard[]> {
    return Array.from(this.cards.values());
  }

  async findByCapability(capability: string): Promise<AgentCard[]> {
    return Array.from(this.cards.values()).filter(c => c.capabilities.includes(capability));
  }

  async findBySubscription(topic: string): Promise<AgentCard[]> {
    return Array.from(this.cards.values()).filter(c =>
      c.subscribes.some(pattern => matchTopic(pattern, topic as TopicString)),
    );
  }
}
