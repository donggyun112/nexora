/**
 * Session lifecycle registry — owns the running→archived→deleted state machine.
 *
 * Live sessions are swept to disk archives after an idle TTL so keep-alive
 * clients don't leak workspaces; an archived session thaws transparently on
 * reattach under the SAME wire id (the client's ref stays valid), which also
 * makes conversations survive a server restart. Archives older than the
 * archive TTL are deleted.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ArchiveLimits, SandboxClient, WorkspaceSession } from '@dongkseo/contracts';
import { safeExtractTar, writeTar } from '@dongkseo/contracts';

export interface SessionLifecycleOptions {
  /** Idle time before a live session is archived to disk. Default 30 minutes. */
  idleTtlMs?: number;
  /** Age before an archive file is deleted. Default 7 days. */
  archiveTtlMs?: number;
  /** Directory holding `<sessionId>.tar` archives. Default `$TMPDIR/nexora-sandbox-archives`. */
  archiveDir?: string;
  /** Sweep cadence. Default 60 seconds. */
  sweepIntervalMs?: number;
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
  private readonly archiveDir: string;
  private readonly sweepIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly client: SandboxClient,
    options: SessionLifecycleOptions = {},
    private readonly archiveLimits?: ArchiveLimits,
  ) {
    this.idleTtlMs = options.idleTtlMs ?? 30 * 60 * 1000;
    this.archiveTtlMs = options.archiveTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.archiveDir = options.archiveDir ?? path.join(os.tmpdir(), 'nexora-sandbox-archives');
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60 * 1000;
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

  /** Explicit teardown: destroys the live session AND its archive. */
  async destroy(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) {
      this.entries.delete(id);
      await entry.session.cleanup();
    }
    await fsp.rm(this.archivePath(id), { force: true });
  }

  /** live → reuse; archived → thaw under the same id; otherwise dead. */
  async reattach(id: string): Promise<{ alive: boolean; root?: string }> {
    const entry = this.entries.get(id);
    if (entry) {
      entry.lastUsedAt = Date.now();
      return { alive: true, root: entry.session.root };
    }
    let archive: Buffer;
    try {
      archive = await fsp.readFile(this.archivePath(id));
    } catch {
      return { alive: false };
    }
    const session = await this.client.create({});
    try {
      await safeExtractTar(archive, session.root, this.archiveLimits);
    } catch (err) {
      // Keep the archive for a later retry; the client falls back to its cold path.
      await session.cleanup().catch(() => {});
      console.warn(`[sandbox-server] thaw failed for ${id}:`, err);
      return { alive: false };
    }
    this.register(id, session);
    await fsp.rm(this.archivePath(id), { force: true });
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
    let names: string[];
    try {
      names = await fsp.readdir(this.archiveDir);
    } catch {
      return; // no archives yet
    }
    for (const name of names) {
      if (!name.endsWith('.tar')) continue;
      const file = path.join(this.archiveDir, name);
      try {
        const stat = await fsp.stat(file);
        if (now - stat.mtimeMs > this.archiveTtlMs) await fsp.rm(file, { force: true });
      } catch {
        // raced with a thaw/destroy — fine
      }
    }
  }

  private async archiveEntry(id: string, opts: { force?: boolean } = {}): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    const lastUsedAtAtDecision = entry.lastUsedAt;
    const bytes = await writeTar(entry.session.root);
    if (!opts.force) {
      // A request may have acquired the session while the tar await was in
      // progress — archiving now would delete the root under it. Nothing was
      // persisted yet (tar is only in memory), so aborting leaves no stale file.
      const current = this.entries.get(id);
      if (current !== entry || current.inFlight > 0 || current.lastUsedAt !== lastUsedAtAtDecision) {
        return;
      }
    }
    await fsp.mkdir(this.archiveDir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(this.archivePath(id), bytes, { mode: 0o600 });
    this.entries.delete(id);
    try {
      await entry.session.cleanup();
    } catch (err) {
      // The archive is already persisted and the entry removed — a cleanup
      // failure only leaks the workspace dir, so don't let it propagate as
      // "archive failed (kept live)", which would be false on both counts.
      console.warn(`[sandbox-server] workspace cleanup failed after archive for ${id}:`, err);
    }
  }

  private archivePath(id: string): string {
    // Session ids are server-minted UUIDs, but sanitize before touching the FS anyway.
    return path.join(this.archiveDir, `${encodeURIComponent(id)}.tar`);
  }
}
