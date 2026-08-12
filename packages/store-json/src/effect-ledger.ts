import fs from 'node:fs';
import path from 'node:path';
import type {
  DescribableStore,
  EffectLedger,
  EffectRecord,
  StoreBackendInfo,
} from '@dongkseo/contracts';
import { EffectWriteFencedError } from '@dongkseo/contracts';

interface PersistedLease {
  owner: string;
  token: number;
  expiresAt: number;
}

interface PersistedLedger {
  version: 1;
  effects: Record<string, Exclude<EffectRecord, { status: 'absent' }>>;
  leases: Record<string, PersistedLease>;
  issuedTokens: Record<string, number>;
}

/**
 * Restart-safe JSON EffectLedger for local development.
 *
 * Updates replace one state file atomically, but the backend deliberately does
 * not claim multi-process safety. Production deployments should use Postgres.
 */
export class EffectLedgerJson implements EffectLedger, DescribableStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'effect-ledger.json');
  }

  describeBackend(): StoreBackendInfo {
    return { name: 'json-file', type: 'dev', durable: true, multiProcess: false };
  }

  async read(runId: string, key: string): Promise<EffectRecord> {
    return this.load().effects[effectKey(runId, key)] ?? { status: 'absent' };
  }

  async start(runId: string, key: string, fencingToken = 0): Promise<boolean> {
    const state = this.load();
    assertFence(state, runId, fencingToken);
    const storageKey = effectKey(runId, key);
    if (state.effects[storageKey]) return false;
    state.effects[storageKey] = { status: 'running' };
    this.save(state);
    return true;
  }

  async finish(
    runId: string,
    key: string,
    value: unknown,
    fencingToken = 0,
  ): Promise<void> {
    const state = this.load();
    assertFence(state, runId, fencingToken);
    state.effects[effectKey(runId, key)] = { status: 'done', value };
    this.save(state);
  }

  async forget(runId: string, key: string, fencingToken = 0): Promise<void> {
    const state = this.load();
    assertFence(state, runId, fencingToken);
    const storageKey = effectKey(runId, key);
    if (state.effects[storageKey]?.status === 'done') return;
    delete state.effects[storageKey];
    this.save(state);
  }

  async acquire(runId: string, owner: string, ttlMs: number): Promise<number> {
    if (!owner) throw new Error('Effect lease owner must not be empty');
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error('Effect lease ttlMs must be a non-negative finite number');
    }
    const state = this.load();
    const now = Date.now();
    const held = state.leases[runId];
    if (held?.owner === owner) {
      held.expiresAt = now + ttlMs;
      this.save(state);
      return held.token;
    }
    if (held && held.expiresAt > now) return 0;

    const token = (state.issuedTokens[runId] ?? 0) + 1;
    state.issuedTokens[runId] = token;
    state.leases[runId] = { owner, token, expiresAt: now + ttlMs };
    this.save(state);
    return token;
  }

  async release(runId: string, owner: string): Promise<void> {
    const state = this.load();
    const held = state.leases[runId];
    if (held?.owner !== owner) return;
    state.leases[runId] = { ...held, owner: '', expiresAt: Date.now() };
    this.save(state);
  }

  private load(): PersistedLedger {
    if (!fs.existsSync(this.file)) return emptyLedger();
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<PersistedLedger>;
    if (parsed.version !== 1 || !parsed.effects || !parsed.leases || !parsed.issuedTokens) {
      throw new Error(`Invalid effect ledger at ${this.file}`);
    }
    return parsed as PersistedLedger;
  }

  private save(state: PersistedLedger): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(state), 'utf8');
      fs.renameSync(temp, this.file);
    } finally {
      if (fs.existsSync(temp)) fs.rmSync(temp);
    }
  }
}

function emptyLedger(): PersistedLedger {
  return { version: 1, effects: {}, leases: {}, issuedTokens: {} };
}

function effectKey(runId: string, key: string): string {
  return JSON.stringify([runId, key]);
}

function assertFence(state: PersistedLedger, runId: string, presentedToken: number): void {
  const issuedToken = state.issuedTokens[runId] ?? 0;
  if (presentedToken !== 0 && presentedToken < issuedToken) {
    throw new EffectWriteFencedError(runId, presentedToken, issuedToken);
  }
}
