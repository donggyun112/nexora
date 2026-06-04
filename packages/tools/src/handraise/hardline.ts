/**
 * Hardline floor — unconditional blocks for catastrophic actions that no
 * approval mode (`off` / `ask` / `block`) and no cached `allow` may bypass.
 *
 * The approval middleware runs this before any other check. Hits short-circuit
 * with an errorResult — the user is NOT prompted, because there is no
 * legitimate "approve" path for `rm -rf /` or `mkfs /dev/sda`. Opting into
 * mode='off' means trusting the agent with your files; it does NOT mean
 * trusting it to wipe the disk.
 *
 * Pattern source: ported from Hermes `detect_hardline_command`. Kept narrow
 * on purpose — broad patterns (`rm -rf`, `sudo`) belong in the approval
 * predicate, not here.
 *
 * This module ships pattern detectors and a string-arg fallback. Callers
 * that want to gate non-shell tools build their own HardlineRule[].
 */

export interface HardlineHit {
  /** Stable identifier for the rule that fired (telemetry, audit). */
  ruleId: string;
  /** Human-readable explanation included in the block message. */
  description: string;
}

export type HardlineRule = (toolName: string, input: unknown) => HardlineHit | null;

/**
 * Walk an arbitrary tool input and return the first string field that looks
 * like a shell command. Used by the default shell rules so callers don't
 * have to hand-pick `input.command` / `input.cmd` / `input.script`.
 */
export function extractCommandString(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return null;
  for (const key of ['command', 'cmd', 'script', 'code']) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

const HARDLINE_SHELL_PATTERNS: Array<{
  ruleId: string;
  description: string;
  pattern?: RegExp;
  test?: (command: string) => boolean;
}> = [
  {
    ruleId: 'hardline.rm_root',
    description: 'recursive rm targeting root or a top-level path',
    // `rm -rf /`, `rm -f -r /Users`, `rm -rf --no-preserve-root /`
    test: isDangerousRecursiveRm,
  },
  {
    ruleId: 'hardline.mkfs',
    description: 'mkfs — filesystem creation wipes the target device',
    pattern: /\bmkfs(?:\.\w+)?\s+\/dev\//,
  },
  {
    ruleId: 'hardline.dd_raw_device',
    description: 'dd writing to a raw block device',
    pattern: /\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|hd|xvd|vd|disk)/,
  },
  {
    ruleId: 'hardline.shutdown',
    description: 'system shutdown / reboot / halt',
    pattern: /\b(?:shutdown|reboot|halt|poweroff|init\s+0|init\s+6|telinit\s+0|telinit\s+6)\b/,
  },
  {
    ruleId: 'hardline.fork_bomb',
    description: 'fork bomb',
    pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,
  },
  {
    ruleId: 'hardline.kill_all',
    description: 'kill -1 / -9 against PID 1 or all processes',
    pattern: /\bkill\s+(?:-[A-Z0-9]+\s+)?-1\b|\bkill\s+(?:-[A-Z0-9]+\s+)?(?:1|-1)\b/,
  },
  {
    ruleId: 'hardline.chmod_root',
    description: 'recursive chmod against / or /etc',
    test: isDangerousRecursiveChmod,
  },
  {
    ruleId: 'hardline.sudo_stdin_password',
    description: 'sudo -S piped with an inline password (credential leak path)',
    pattern: /\becho\s+['"]?[^|\s'"]+['"]?\s*\|\s*sudo\s+-S\b/,
  },
];

/**
 * Default rule: match the input's command string against the shell pattern
 * list above. Returns the first hit, or null.
 */
export const defaultShellHardlineRule: HardlineRule = (_toolName, input) => {
  const cmd = extractCommandString(input);
  if (!cmd) return null;
  for (const entry of HARDLINE_SHELL_PATTERNS) {
    if (entry.test?.(cmd) || entry.pattern?.test(cmd)) {
      return { ruleId: entry.ruleId, description: entry.description };
    }
  }
  return null;
};

/** Compose multiple rules — first hit wins. */
export function composeHardlineRules(...rules: HardlineRule[]): HardlineRule {
  return (toolName, input) => {
    for (const rule of rules) {
      const hit = rule(toolName, input);
      if (hit) return hit;
    }
    return null;
  };
}

function isDangerousRecursiveRm(command: string): boolean {
  const words = shellWords(command);
  for (let i = 0; i < words.length; i += 1) {
    if (!isCommandName(words[i], 'rm')) continue;
    const args = words.slice(i + 1);
    if (!args.some(isRecursiveRmFlag)) continue;
    if (args.some(isRootOrTopLevelPath)) return true;
  }
  return false;
}

function isDangerousRecursiveChmod(command: string): boolean {
  const words = shellWords(command);
  for (let i = 0; i < words.length; i += 1) {
    if (!isCommandName(words[i], 'chmod')) continue;
    const args = words.slice(i + 1);
    if (!args.some(isRecursiveChmodFlag)) continue;
    if (args.some(isRootOrSystemPath)) return true;
  }
  return false;
}

function shellWords(command: string): string[] {
  const matches = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g) ?? [];
  return matches.map(stripOuterQuotes);
}

function stripOuterQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function isCommandName(value: string, expected: string): boolean {
  return value === expected || value.endsWith(`/${expected}`);
}

function isRecursiveRmFlag(value: string): boolean {
  if (value === '--recursive' || value.startsWith('--recursive=')) return true;
  if (value.startsWith('--')) return false;
  return value.startsWith('-') && /[rR]/.test(value);
}

function isRecursiveChmodFlag(value: string): boolean {
  if (value === '--recursive' || value.startsWith('--recursive=')) return true;
  if (value.startsWith('--')) return false;
  return value.startsWith('-') && value.includes('R');
}

function isRootOrTopLevelPath(value: string): boolean {
  const target = trimTrailingSlashes(value);
  if (target === '/' || target === '/*') return true;
  return /^\/[^/\s*]+$/.test(target);
}

function isRootOrSystemPath(value: string): boolean {
  const target = trimTrailingSlashes(value);
  return target === '/' || /^\/(?:etc|usr|bin)(?:\/\*)?$/.test(target);
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '') || '/';
}
