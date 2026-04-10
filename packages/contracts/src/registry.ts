/**
 * AgentRegistry — abstract contract for registering agent cards.
 *
 * The in-memory implementation lives in @nexora/registry. Production
 * deployments can provide a Redis/etcd-backed implementation behind this
 * interface without touching agent code.
 *
 * The contract lives in @nexora/contracts (not in @nexora/registry) so
 * @nexora/core can call `registry.register(card)` during bootstrap without
 * creating a circular dependency from the core runtime into the platform layer.
 */

import type { AgentCard } from './agent-card.js';

export interface AgentRegistry {
  /** Register (or re-register) an agent card. Idempotent. */
  register(card: AgentCard): Promise<void>;

  /** Remove a card by agent name. */
  unregister(name: string): Promise<void>;

  /** Look up a card by agent name. Returns null if not registered. */
  get(name: string): Promise<AgentCard | null>;

  /** List all currently registered cards. */
  list(): Promise<AgentCard[]>;

  /** Find all cards that declare a given capability. */
  findByCapability(capability: string): Promise<AgentCard[]>;

  /**
   * Find all cards that subscribe to a given topic (wildcard patterns in
   * `card.subscribes` are honored).
   */
  findBySubscription(topic: string): Promise<AgentCard[]>;
}
