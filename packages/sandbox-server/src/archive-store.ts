/**
 * ArchiveStore — SessionRegistry 상태머신의 archive "매체" seam.
 *
 * 상태머신(idle TTL·in-flight pin·drain·sweep 주기)은 registry 가 소유하고,
 * "잠재운 세션을 어디에 어떻게 보존하느냐"만 구현이 바뀐다:
 * tar 파일(ASRT backend) vs durable 디렉토리(overlay-rootfs backend).
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ArchiveLimits, SandboxClient, WorkspaceSession } from '@dongkseo/contracts';
import { safeExtractTar, writeTar } from '@dongkseo/contracts';

export interface ArchiveStore {
  /**
   * Persist a quiesced session. Returns false when aborted because the session
   * became active again mid-archive (checked via `stillValid` after any slow
   * snapshot work, unless `force`). On false nothing was persisted.
   */
  archive(id: string, session: WorkspaceSession, opts: { force?: boolean; stillValid: () => boolean }): Promise<boolean>;
  /** Revive an archived session under the same id; null when nothing is archived. */
  thaw(id: string): Promise<WorkspaceSession | null>;
  /** Permanently drop archived state for id (explicit DELETE). */
  delete(id: string): Promise<void>;
  /** Drop archived state older than olderThanMs. liveIds are currently-live sessions to skip. */
  sweepStale(olderThanMs: number, liveIds: ReadonlySet<string>, now?: number): Promise<void>;
}

export interface TarArchiveStoreOptions {
  /** Directory holding `<sessionId>.tar`. Default `$TMPDIR/nexora-sandbox-archives`. */
  archiveDir?: string;
  /** Extraction limits applied on thaw. */
  archiveLimits?: ArchiveLimits;
}

export class TarArchiveStore implements ArchiveStore {
  private readonly archiveDir: string;
  private readonly archiveLimits?: ArchiveLimits;

  constructor(
    private readonly client: SandboxClient,
    options: TarArchiveStoreOptions = {},
  ) {
    this.archiveDir = options.archiveDir ?? path.join(os.tmpdir(), 'nexora-sandbox-archives');
    this.archiveLimits = options.archiveLimits;
  }

  async archive(id: string, session: WorkspaceSession, opts: { force?: boolean; stillValid: () => boolean }): Promise<boolean> {
    const bytes = await writeTar(session.root);
    // A request may have acquired the session while the tar await was in
    // progress — persisting now would let the registry delete the root under
    // it. Nothing was persisted yet (tar is only in memory), so aborting
    // leaves no stale file.
    if (!opts.force && !opts.stillValid()) return false;
    await fsp.mkdir(this.archiveDir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(this.archivePath(id), bytes, { mode: 0o600 });
    return true;
  }

  async thaw(id: string): Promise<WorkspaceSession | null> {
    let archive: Buffer;
    try {
      archive = await fsp.readFile(this.archivePath(id));
    } catch {
      return null;
    }
    const session = await this.client.create({});
    try {
      await safeExtractTar(archive, session.root, this.archiveLimits);
    } catch (err) {
      // Keep the archive for a later retry; the caller falls back to its cold path.
      await session.cleanup().catch(() => {});
      console.warn(`[sandbox-server] thaw failed for ${id}:`, err);
      return null;
    }
    await fsp.rm(this.archivePath(id), { force: true });
    return session;
  }

  async delete(id: string): Promise<void> {
    await fsp.rm(this.archivePath(id), { force: true });
  }

  async sweepStale(olderThanMs: number, _liveIds: ReadonlySet<string>, now = Date.now()): Promise<void> {
    // Live sessions have no tar on disk, so liveIds is irrelevant here.
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
        if (now - stat.mtimeMs > olderThanMs) await fsp.rm(file, { force: true });
      } catch {
        // raced with a thaw/destroy — fine
      }
    }
  }

  private archivePath(id: string): string {
    // Session ids are server-minted UUIDs, but sanitize before touching the FS anyway.
    return path.join(this.archiveDir, `${encodeURIComponent(id)}.tar`);
  }
}
