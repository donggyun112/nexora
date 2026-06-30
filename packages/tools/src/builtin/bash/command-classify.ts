/**
 * Read-only / concurrency classification for shell commands, built on the
 * vendored bash AST (bash-ast.ts).
 *
 * The framework's tool-executor runs `isConcurrencySafe` tools as a parallel
 * batch and everything else sequentially (packages/core tool-executor). exec
 * declared none of these, so even `ls`/`cat`/`grep` ran serialized. This module
 * lets exec answer "is this command read-only?" so read commands can batch.
 *
 * SYNC by necessity: ToolDefinition.isReadOnly/isConcurrencySafe are synchronous
 * (the executor calls them inline). The vendored parser is pure-TS, so we drive
 * it synchronously via getParserModule().parse + parseForSecurityFromAst rather
 * than the async parseForSecurity wrapper.
 *
 * FAIL-CLOSED: anything we can't prove read-only — too-complex parse, parse
 * abort, unknown command, any write redirect, an exec/write-capable flag — is
 * classified NOT read-only. A read command mis-flagged as not-read-only only
 * loses parallelism; the inverse (a writer treated as read-only) would be a
 * correctness bug, so we never err that way.
 *
 * The read-only command set is ported from claude-code's READONLY_COMMANDS
 * (utils/shell/readOnlyCommandValidation.ts) — its curation rule is "safe with
 * ANY flags"; commands with a write-via-flag footgun (date -s, sort -o, find
 * -exec, hostname, info -o, tee, sed -i) are deliberately excluded and handled
 * by special cases or omission here.
 */

import { getParserModule } from './bash-parser.js';
import {
  parseForSecurityFromAst,
  type ParseForSecurityResult,
  type Redirect,
  type SimpleCommand,
} from './bash-ast.js';
import { PARSE_ABORTED } from './bash-parse.js';

const MAX_COMMAND_LENGTH = 10_000;

/**
 * Commands that are read-only regardless of their flags. Ported verbatim from
 * claude-code READONLY_COMMANDS plus a small safe core (ls/pwd/echo/printf and
 * the search tools) that upstream handles via flag-validated allowlists rather
 * than the bare-safe list.
 */
const READ_ONLY_COMMANDS = new Set<string>([
  // safe core
  'ls', 'pwd', 'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg',
  // time / date (read-only forms only; `date -s` excluded by omission)
  'cal', 'uptime',
  // file content viewing
  'cat', 'head', 'tail', 'wc', 'stat', 'strings', 'hexdump', 'od', 'nl',
  // system info
  'id', 'uname', 'free', 'df', 'du', 'locale', 'groups', 'nproc',
  // path information
  'basename', 'dirname', 'realpath', 'readlink',
  // text processing (output to stdout only)
  'cut', 'paste', 'tr', 'column', 'tac', 'rev', 'fold', 'expand', 'unexpand',
  'fmt', 'comm', 'cmp', 'numfmt', 'diff',
  // misc safe
  'true', 'false', 'sleep', 'which', 'type', 'expr', 'test', 'getconf',
  'seq', 'tsort', 'pr',
]);

/**
 * git subcommands that are read-only irrespective of flags. Ported from
 * GIT_READ_ONLY_COMMANDS, MINUS branch/tag/remote — those can write depending
 * on flags (`git branch -d`, `git tag -a`, `git remote add`) and we don't do
 * per-flag validation, so they fail closed.
 */
const GIT_READ_ONLY_SUBCOMMANDS = new Set<string>([
  'diff', 'log', 'show', 'status', 'blame', 'cat-file', 'describe',
  'for-each-ref', 'grep', 'ls-files', 'ls-remote', 'merge-base', 'reflog',
  'rev-list', 'rev-parse', 'shortlog',
]);

/**
 * `find` predicates/actions that execute commands or write the filesystem.
 * Their presence makes a `find` invocation not read-only.
 */
const FIND_UNSAFE_TOKENS = new Set<string>([
  '-exec', '-execdir', '-ok', '-okdir', '-delete',
  '-fprint', '-fprint0', '-fprintf', '-fls',
]);

/** A redirect that writes (or could create/truncate) a file. */
function isWriteRedirect(r: Redirect): boolean {
  return (
    r.op === '>' || r.op === '>>' || r.op === '>&' ||
    r.op === '>|' || r.op === '&>' || r.op === '&>>'
  );
}

/** Is a single parsed simple command read-only? */
function isReadOnlySimpleCommand(cmd: SimpleCommand): boolean {
  // Any write redirect disqualifies regardless of the command.
  if (cmd.redirects.some(isWriteRedirect)) return false;

  const argv = cmd.argv;
  if (argv.length === 0) return false;
  const name = argv[0];

  if (name === 'git') {
    const sub = argv[1];
    return sub !== undefined && GIT_READ_ONLY_SUBCOMMANDS.has(sub);
  }

  if (name === 'find') {
    return !argv.slice(1).some((a) => FIND_UNSAFE_TOKENS.has(a));
  }

  return READ_ONLY_COMMANDS.has(name);
}

/**
 * Synchronously analyze a shell-string command via the vendored AST. Returns
 * the fail-closed ParseForSecurity result (simple / too-complex / unavailable).
 */
export function analyzeShellCommand(command: string): ParseForSecurityResult {
  if (command === '') return { kind: 'simple', commands: [] };
  if (command.length > MAX_COMMAND_LENGTH) {
    return { kind: 'too-complex', reason: 'Command exceeds max length' };
  }
  const mod = getParserModule();
  if (!mod) return { kind: 'parse-unavailable' };
  let raw;
  try {
    raw = mod.parse(command);
  } catch {
    return parseForSecurityFromAst(command, PARSE_ABORTED);
  }
  // null from the pure-TS parser = timeout/node-budget abort → fail closed.
  return parseForSecurityFromAst(command, raw === null ? PARSE_ABORTED : raw);
}

/**
 * True only if every simple command in the string is read-only. Empty command,
 * too-complex, parse-unavailable, or any non-read-only subcommand → false.
 */
export function isReadOnlyShellCommand(command: string): boolean {
  const result = analyzeShellCommand(command);
  if (result.kind !== 'simple') return false;
  if (result.commands.length === 0) return false;
  return result.commands.every(isReadOnlySimpleCommand);
}

/**
 * Read-only check for argv-form invocations (no shell). argv is already a single
 * simple command with no operators or redirects, so we classify it directly
 * without parsing.
 */
export function isReadOnlyArgv(argv: string[]): boolean {
  if (argv.length === 0) return false;
  return isReadOnlySimpleCommand({ argv, envVars: [], redirects: [], text: '' });
}

/**
 * argv[0] of the last simple command — the command whose exit code sets `$?`.
 * Used to pick exit-code semantics. Null when the command isn't a clean
 * sequence of simple commands.
 */
export function lastBaseCommand(result: ParseForSecurityResult): string | null {
  if (result.kind !== 'simple' || result.commands.length === 0) return null;
  const last = result.commands[result.commands.length - 1];
  return last.argv[0] ?? null;
}
