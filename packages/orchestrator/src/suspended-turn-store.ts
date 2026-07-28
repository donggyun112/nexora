/**
 * In-memory SuspendedTurnStore — default implementation for dev/test.
 *
 * Production deployments should use a durable backend (@dongkseo/store-json
 * file-based, or @dongkseo/store-pg Postgres) so parked handraise turns
 * survive a process restart. This implementation exists so tests can exercise
 * the suspend/resume code paths without a real store, and so single-process
 * demos can park-and-resume without wiring anything extra.
 */

import type { SuspendedTurnStore, SuspendedTurnState } from '@dongkseo/contracts';

export class InMemorySuspendedTurnStore implements SuspendedTurnStore {
  private readonly turns = new Map<string, SuspendedTurnState>();

  async save(state: SuspendedTurnState): Promise<void> {
    // Store a structural clone so later mutations on the original don't
    // corrupt the saved state.
    this.turns.set(state.pendingId, structuredClone(state));
  }

  async claim(pendingId: string): Promise<SuspendedTurnState | null> {
    const state = this.turns.get(pendingId);
    if (!state || state.status !== 'awaiting') return null;
    const claimed: SuspendedTurnState = { ...structuredClone(state), status: 'resumed' };
    this.turns.set(pendingId, claimed);
    return structuredClone(claimed);
  }

  async release(pendingId: string): Promise<boolean> {
    const state = this.turns.get(pendingId);
    if (!state || state.status !== 'resumed') return false;
    this.turns.set(pendingId, { ...state, status: 'awaiting' });
    return true;
  }

  async load(pendingId: string): Promise<SuspendedTurnState | null> {
    const s = this.turns.get(pendingId);
    return s ? structuredClone(s) : null;
  }

  async delete(pendingId: string): Promise<void> {
    this.turns.delete(pendingId);
  }

  async listAwaiting(): Promise<SuspendedTurnState[]> {
    return Array.from(this.turns.values())
      .filter(s => s.status === 'awaiting')
      .map(s => structuredClone(s));
  }
}
