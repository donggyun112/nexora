/**
 * Store backend classification — dev vs production.
 *
 * store-json (JSON files) and InMemory implementations are dev-only.
 * Production deployments need durable backends that survive restart
 * and support concurrent access across processes.
 *
 * This file defines the classification so the framework can warn at
 * startup if a dev-only store is used in a production context.
 */

export type StoreBackendType = 'dev' | 'production';

export interface StoreBackendInfo {
  /** Human-readable name (e.g. 'json-file', 'postgresql', 'in-memory') */
  name: string;
  /** Is this safe for production multi-tenant use? */
  type: StoreBackendType;
  /** Does data survive process restart? */
  durable: boolean;
  /** Supports concurrent access from multiple processes? */
  multiProcess: boolean;
}

/**
 * Declare your store's backend characteristics. Called by the store factory
 * and checked by bootstrap to warn about dev-only stores in production.
 */
export interface DescribableStore {
  describeBackend(): StoreBackendInfo;
}
