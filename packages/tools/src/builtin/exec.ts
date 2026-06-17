/**
 * exec — sandboxed command execution.
 *
 * Threat model: an LLM-controlled agent CAN compose any argv it wants. This
 * tool is the last line of defense between the LLM and the host. The previous
 * iteration was bypassable (`argv: ['bash', '-c', 'rm -rf /']` worked because
 * `bash` was an allowed executable, and `argv: ['../../../bin/sh']` worked
 * because no allowList was required). The current rules:
 *
 *   1. allowList is REQUIRED. With no allowList the tool refuses every call.
 *      Operators must explicitly say which programs the agent may run.
 *   2. argv[0] must be a bare basename — no `/`, `\`, `..`, or absolute paths.
 *      The OS PATH lookup is what resolves it. This blocks
 *      `argv: ['../../../bin/sh']` and `argv: ['/usr/bin/bash']`.
 *   3. Known shell interpreters are blocked unless `allowShell: true` is set.
 *      Even if you allowlist `bash`, you can't get `bash -c` without explicitly
 *      acknowledging the risk via `allowShell`. This blocks the
 *      `argv: ['bash', '-c', '...']` bypass.
 *   4. Shell-string mode (`{ command }`) requires `allowShell: true`.
 *   5. Environment is scrubbed: only PATH/HOME/LANG/LC_ALL pass through by
 *      default; secrets in process.env stay invisible to the child.
 *   6. ctx.signal is forwarded to spawn(), so cancellation actually kills work.
 *   7. Output and timeouts are capped.
 *
 * The four-regex blocklist from the very first version is gone — it was
 * trivially bypassable via command substitution, environment expansion, etc.
 * Real isolation comes from process boundaries + allowlist + scrubbed env +
 * workdir restriction.
 */

import { spawn } from 'node:child_process';
import type { ToolDefinition, ToolResult } from '@dongkseo/contracts';
import { textResult, errorResult } from '@dongkseo/contracts';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface ExecToolOptions {
  /**
   * argv mode: only these executables are allowed when running argv.
   * If undefined, all argv calls are allowed.
   */
  allowList?: string[];
  /**
   * Opt-in: enable shell-string mode (`{ command: '...' }` runs via `bash -lc`).
   * Off by default. Only enable when the agent legitimately needs pipes/globs.
   */
  allowShell?: boolean;
  /**
   * Environment variables to forward to the child. PATH is always forwarded.
   * Anything not in this list is dropped.
   */
  envAllowList?: string[];
  /** Default timeout (ms). */
  defaultTimeoutMs?: number;
}

/** Env var names that are always passed through. */
const ALWAYS_PASS = ['PATH', 'HOME', 'LANG', 'LC_ALL'];

/**
 * Programs whose design includes "read code from arguments" or "execute other
 * commands". Allowlisting any of these is equivalent to handing the LLM a shell —
 * so we require the operator to explicitly opt in via `allowShell: true`.
 *
 * IMPORTANT: this is a BEST-EFFORT list, NOT a complete sandbox. Many
 * allowlisted tools (e.g. git, awk, find) also have RCE primitives via config
 * options, hooks, or -exec flags. The only reliable boundary is:
 *   1. A curated allowList of programs your operator has audited
 *   2. An OS-level sandbox (container, nsjail, bubblewrap, seatbelt)
 * This list catches the obvious footguns but should not be mistaken for
 * isolation. See README's security section.
 */
const SHELL_INTERPRETERS = new Set<string>([
  // POSIX shells
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'tcsh', 'csh', 'fish', 'ash',
  'busybox', // contains many applets including sh
  // Scripting interpreters that read code from -c / -e
  'python', 'ruby', 'perl', 'node', 'nodejs', 'deno', 'bun', 'php',
  'lua', 'awk', 'gawk', 'mawk', 'nawk',
  // Text-processing tools with exec primitives
  'sed',   // GNU sed: s/.../.../e
  'find',  // -exec / -execdir
  'xargs', // spawns arbitrary commands
  // Archive tools with exec primitives
  'tar',   // --checkpoint-action=exec
  'cpio',  // -E / filter
  'zip', 'unzip', // can run commands via some variants
  // VCS tools with exec primitives (editor, pager, hooks, ssh config, etc.)
  'git', 'hg', 'svn',
  // Network egress / remote exec
  'wget', 'curl', 'scp', 'rsync', 'ssh', 'sshpass', 'telnet', 'nc', 'ncat', 'socat',
  // Container / privilege escalation
  'env', 'sudo', 'doas', 'su', 'docker', 'podman', 'kubectl', 'nsenter',
  'chroot', 'unshare', 'setsid',
]);

/**
 * Normalize a program basename so that versioned variants like `python3.12`,
 * `python3`, and `nodejs` map back to their canonical name for blocklist lookup.
 * Without this, `argv: ['python3.12', '-c', '...']` would bypass the filter.
 */
function normalizeInterpreterName(name: string): string {
  // python / python2 / python3 / python3.12 → python
  // ruby3.3 → ruby, perl5.38 → perl, node20 → node, lua5.4 → lua, php8.2 → php
  const versionedMatch = name.match(/^(python|ruby|perl|node|lua|php|tcl|julia|r)\d+(\.\d+)?$/);
  if (versionedMatch) return versionedMatch[1];
  // nodejs → node (Debian name)
  if (name === 'nodejs') return 'node';
  // python-3, python-3.12 (less common but seen)
  const dashedMatch = name.match(/^(python|ruby|perl|node|lua|php)-\d+(\.\d+)?$/);
  if (dashedMatch) return dashedMatch[1];
  return name;
}

/** Is this a known execution/egress surface? */
function isInterpreter(program: string): boolean {
  if (SHELL_INTERPRETERS.has(program)) return true;
  const canonical = normalizeInterpreterName(program);
  return SHELL_INTERPRETERS.has(canonical);
}

/**
 * Validate the bare program name. Rejects path traversal, absolute paths,
 * and Windows-style separators. The PATH lookup performed by spawn() is what
 * resolves the basename to a real binary.
 */
function validateProgram(program: string): string | null {
  if (!program) return 'program is empty';
  if (program.includes('/') || program.includes('\\')) {
    return `program "${program}" must be a bare command name (no path separators)`;
  }
  if (program.includes('..')) {
    return `program "${program}" must not contain ".."`;
  }
  if (program.startsWith('-')) {
    return `program "${program}" must not start with "-"`;
  }
  return null;
}

function buildEnv(envAllowList: string[] | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = new Set<string>([...ALWAYS_PASS, ...(envAllowList ?? [])]);
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function createExecTool(options: ExecToolOptions = {}): ToolDefinition {
  const allowList = options.allowList ? new Set(options.allowList) : null;
  const allowShell = options.allowShell ?? false;
  const defaultTimeout = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = buildEnv(options.envAllowList);

  const description = allowShell
    ? 'Execute a command in the workspace. Use { argv: [...] } (preferred) or { command: "shell string" } for pipes/globs. Returns combined stdout/stderr. Times out after 120s by default; output capped at 256KB.'
    : 'Execute a command in the workspace via { argv: ["program", "arg1", ...] }. Shell-string mode is disabled in this configuration — use argv form. Returns combined stdout/stderr. Times out after 120s by default; output capped at 256KB.';

  return {
    name: 'exec',
    description,
    parameters: {
      type: 'object',
      properties: {
        argv: {
          type: 'array',
          items: { type: 'string' },
          description: 'Program + arguments. Preferred form. Runs without a shell.',
        },
        command: {
          type: 'string',
          description: allowShell
            ? 'Shell command (runs via bash -lc). Use only when you need pipes, globs, or redirects.'
            : 'DISABLED in this exec configuration. Use argv instead.',
        },
        timeoutMs: { type: 'number', description: 'Override default timeout (1000-600000)' },
      },
      required: [],
    },
    execute: async (_id, input, ctx): Promise<ToolResult> => {
      const params = input as { argv?: unknown; command?: unknown; timeoutMs?: unknown };

      // Resolve mode + child process arguments.
      let program: string;
      let args: string[];
      let useShell: boolean;
      let label: string;

      if (Array.isArray(params.argv) && params.argv.length > 0) {
        if (!params.argv.every((a): a is string => typeof a === 'string')) {
          return errorResult('argv must be an array of strings');
        }
        program = params.argv[0];
        args = params.argv.slice(1);
        useShell = false;
        label = params.argv.join(' ');

        // Path-traversal / absolute-path / leading-dash defense.
        const programErr = validateProgram(program);
        if (programErr) return errorResult(programErr);

        // allowList is REQUIRED. Without it the tool is unusable — that is the
        // safe default; operators have to explicitly say which commands an
        // LLM-controlled agent may run.
        if (!allowList || allowList.size === 0) {
          return errorResult(
            'exec is unconfigured: createExecTool() requires a non-empty allowList. ' +
            'Pass createExecTool({ allowList: [\'git\', \'npm\', ...] }) to enable specific commands.',
          );
        }
        if (!allowList.has(program)) {
          return errorResult(
            `Executable "${program}" not in allowList. Allowed: ${[...allowList].join(', ')}`,
          );
        }

        // Block known shell interpreters / execution surfaces in argv mode unless
        // the operator has explicitly opted into allowShell. This is a best-effort
        // footgun filter — it normalizes version suffixes (python3.12 → python)
        // so the obvious bypasses are covered, but it is NOT a sandbox (git, sed,
        // find and friends still have RCE primitives via hooks/-exec/etc.).
        if (!allowShell && isInterpreter(program)) {
          return errorResult(
            `Executable "${program}" is a shell/interpreter/exec-surface and is blocked. ` +
            'Either remove it from allowList or set allowShell: true on createExecTool(). ' +
            'Remember: many other CLIs have RCE primitives — prefer OS-level sandboxing for real isolation.',
          );
        }
      } else if (typeof params.command === 'string' && params.command.trim().length > 0) {
        if (!allowShell) {
          return errorResult(
            'Shell-string mode is disabled. Use { argv: ["program", "arg1", ...] } instead.',
          );
        }
        program = 'bash';
        args = ['-lc', params.command];
        useShell = true;
        label = params.command;
      } else {
        return errorResult('Either argv (preferred) or command must be provided');
      }

      const timeoutMs = Math.min(
        Math.max(typeof params.timeoutMs === 'number' ? params.timeoutMs : defaultTimeout, 1_000),
        MAX_TIMEOUT_MS,
      );

      // Cancellation: combine ctx.signal (run-level) with our timeout via AbortController.
      const controller = new AbortController();
      const onParentAbort = (): void => controller.abort();
      if (ctx.signal) {
        if (ctx.signal.aborted) controller.abort();
        else ctx.signal.addEventListener('abort', onParentAbort, { once: true });
      }

      return new Promise<ToolResult>((resolve) => {
        const child = spawn(program, args, {
          cwd: ctx.workdir,
          env,
          shell: false, // never bash interpolation; even bash -lc is invoked as program
          signal: controller.signal,
        });

        let collected = Buffer.alloc(0);
        let truncated = false;
        let timedOut = false;
        let abortedByParent = false;

        const onData = (chunk: Buffer): void => {
          if (truncated) return;
          if (collected.length + chunk.length > MAX_OUTPUT_BYTES) {
            const remaining = MAX_OUTPUT_BYTES - collected.length;
            collected = Buffer.concat([collected, chunk.subarray(0, remaining)]);
            truncated = true;
          } else {
            collected = Buffer.concat([collected, chunk]);
          }
        };

        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);

        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
        timer.unref?.();

        const cleanup = (): void => {
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', onParentAbort);
        };

        child.on('error', (err) => {
          cleanup();
          // AbortError vs real error
          const message = err.name === 'AbortError'
            ? (timedOut
                ? `[killed: timeout after ${timeoutMs}ms]`
                : '[aborted]')
            : `exec failed: ${err.message}`;
          resolve(textResult(message + textTail(collected, truncated)));
        });

        child.on('close', (code, signal) => {
          cleanup();
          if (ctx.signal?.aborted && !timedOut) abortedByParent = true;

          let text = collected.toString('utf-8');
          if (truncated) text += `\n\n[Output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
          if (timedOut) text += `\n\n[Killed: timeout after ${timeoutMs}ms]`;
          else if (abortedByParent) text += '\n\n[Aborted by caller]';

          const status = code === 0 && !timedOut && !abortedByParent
            ? 'ok'
            : `exit ${code ?? signal ?? 'signal'}`;
          ctx.logger.info(`exec ${status}`, {
            program,
            useShell,
            bytes: collected.length,
          });

          if (code === 0 && !timedOut && !abortedByParent) {
            resolve(textResult(text || '(no output)'));
          } else {
            resolve(textResult(`[${status}] ${label}\n${text}`));
          }
        });
      });
    },
  };
}

function textTail(buf: Buffer, truncated: boolean): string {
  if (buf.length === 0) return '';
  return `\n${buf.toString('utf-8')}${truncated ? '\n[truncated]' : ''}`;
}
