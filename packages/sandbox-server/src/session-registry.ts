/**
 * Session lifecycle registry — owns the running→archived→deleted state machine.
 *
 * Live sessions are archived via the injected ArchiveStore after an idle TTL so
 * keep-alive clients don't leak workspaces; an archived session thaws
 * transparently on reattach under the SAME wire id (the client's ref stays
 * valid), which also makes conversations survive a server restart. Archived
 * state older than the archive TTL is swept.
 */
import type { ArchiveLimits, SandboxClient, WorkspaceSession } from '@dongkseo/contracts';
import { TarArchiveStore, type ArchiveStore } from './archive-store.js';

export interface SessionLifecycleOptions {
  /** Idle time before a live session is archived. Default 30 minutes. */
  idleTtlMs?: number;
  /** Age before archived state is deleted. Default 7 days. */
  archiveTtlMs?: number;
  /** Sweep cadence. Default 60 seconds. */
  sweepIntervalMs?: number;
  /** (Backward compat) Directory for tar archives when using TarArchiveStore. */
  archiveDir?: string;
  /** (Backward compat) Extraction limits for tar archives. */
  archiveLimits?: ArchiveLimits;
}

interface SessionEntry {
  session: WorkspaceSession;
  lastUsedAt: number;
  inFlight: number;
}

export class SessionRegistry {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly idleTtlMs: number;
  private readonly archiveTtlMs: number;
  private readonly sweepIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private readonly store: ArchiveStore;

  constructor(
    storeOrClient: ArchiveStore | SandboxClient,
    options: SessionLifecycleOptions = {},
    archiveLimits?: ArchiveLimits,
  ) {
    this.idleTtlMs = options.idleTtlMs ?? 30 * 60 * 1000;
    this.archiveTtlMs = options.archiveTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60 * 1000;

    // Support both new signature (ArchiveStore) and legacy signature (SandboxClient).
    // When called with a client, create a TarArchiveStore automatically.
    if (this.isClient(storeOrClient)) {
      this.store = new TarArchiveStore(storeOrClient, {
        archiveDir: options.archiveDir,
        archiveLimits: archiveLimits ?? options.archiveLimits,
      });
    } else {
      this.store = storeOrClient;
    }
  }

  private isClient(obj: ArchiveStore | SandboxClient): obj is SandboxClient {
    return typeof (obj as SandboxClient).create === 'function';
  }

  register(id: string, session: WorkspaceSession): void {
    this.entries.set(id, { session, lastUsedAt: Date.now(), inFlight: 0 });
  }

  /** Look up a live session for a request: touches idle time and pins it against the sweep. */
  acquire(id: string): WorkspaceSession | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    entry.lastUsedAt = Date.now();
    entry.inFlight += 1;
    return entry.session;
  }

  release(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    entry.lastUsedAt = Date.now();
  }

  /** Explicit teardown: destroys the live session AND its archived state. */
  async destroy(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) {
      this.entries.delete(id);
      await entry.session.cleanup();
    }
    await this.store.delete(id);
  }

  /** live → reuse; archived → thaw under the same id; otherwise dead. */
  async reattach(id: string): Promise<{ alive: boolean; root?: string }> {
    const entry = this.entries.get(id);
    if (entry) {
      entry.lastUsedAt = Date.now();
      return { alive: true, root: entry.session.root };
    }
    const session = await this.store.thaw(id);
    if (!session) return { alive: false };
    this.register(id, session);
    return { alive: true, root: session.root };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) => console.warn('[sandbox-server] sweep failed:', err));
    }, this.sweepIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Archive every live session (graceful shutdown). */
  async archiveAll(): Promise<void> {
    // Bounded drain: availability over perfection — give in-flight requests a
    // short grace period, then archive anyway so shutdown can't hang forever.
    const drainPollMs = 50;
    const drainTimeoutMs = 5000;
    for (const [id, entry] of [...this.entries]) {
      const deadline = Date.now() + drainTimeoutMs;
      while (entry.inFlight > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, drainPollMs));
      }
      await this.archiveEntry(id, { force: true }).catch((err) =>
        console.warn(`[sandbox-server] shutdown archive failed for ${id}:`, err),
      );
    }
  }

  /** Abrupt-close cleanup: drop live sessions without archiving. */
  async destroyAllLive(): Promise<void> {
    for (const [id, entry] of [...this.entries]) {
      this.entries.delete(id);
      await entry.session.cleanup().catch(() => {});
    }
  }

  async sweep(now = Date.now()): Promise<void> {
    for (const [id, entry] of [...this.entries]) {
      if (entry.inFlight > 0) continue;
      if (now - entry.lastUsedAt <= this.idleTtlMs) continue;
      // Failure keeps the session live (retried next sweep) — leak beats data loss.
      await this.archiveEntry(id).catch((err) =>
        console.warn(`[sandbox-server] archive failed for ${id} (kept live):`, err),
      );
    }
    await this.store
      .sweepStale(this.archiveTtlMs, new Set(this.entries.keys()), now)
      .catch((err) => console.warn('[sandbox-server] archive sweep failed:', err));
  }

  private async archiveEntry(id: string, opts: { force?: boolean } = {}): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    const lastUsedAtAtDecision = entry.lastUsedAt;
    const stillValid = (): boolean => {
      const current = this.entries.get(id);
      return current === entry && current.inFlight === 0 && current.lastUsedAt === lastUsedAtAtDecision;
    };
    const archived = await this.store.archive(id, entry.session, { force: opts.force, stillValid });
    if (!archived) return;
    this.entries.delete(id);
    try {
      await entry.session.cleanup();
    } catch (err) {
      // Archived state is already persisted and the entry removed — a cleanup
      // failure only leaks the workspace, so don't let it propagate as
      // "archive failed (kept live)", which would be false on both counts.
      console.warn(`[sandbox-server] workspace cleanup failed after archive for ${id}:`, err);
    }
  }
}
