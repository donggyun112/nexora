/**
 * spawnCollect — shared child-process spawn+collect helper for sandbox backends.
 *
 * Both the bwrap-overlay backend (overlay-rootfs-client.ts) and the gVisor backend
 * (gvisor-client.ts) shell out to a different binary (`bwrap` vs `runsc`) but need
 * identical process plumbing: a fixed sandbox PATH + HOME=/root env (with cmd.env
 * layered on top), stdout/stderr collection, timeout/abort → SIGKILL, and a
 * SandboxCommandResult that always resolves (never rejects) even on spawn error.
 */
import { spawn } from 'node:child_process';
import type { SandboxCommand, SandboxCommandResult } from '@dongkseo/contracts';

export const SANDBOX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export async function spawnCollect(bin: string, args: string[], cmd: SandboxCommand): Promise<SandboxCommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(bin, args, {
      env: { PATH: SANDBOX_PATH, HOME: '/root', ...cmd.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const timer = cmd.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, cmd.timeoutMs)
      : undefined;
    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGKILL');
    };
    cmd.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      cmd.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: null, signal: null, stdout, stderr: `${stderr}\n${String(err)}`.trim() });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      cmd.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        ...(timedOut ? { timedOut: true } : {}),
        ...(aborted ? { aborted: true } : {}),
      });
    });
  });
}
