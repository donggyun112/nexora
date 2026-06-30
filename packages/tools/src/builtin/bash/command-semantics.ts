/**
 * Exit-code semantics — interpret a command's exit code in context.
 *
 * Vendored from claude-code `tools/BashTool/commandSemantics.ts`. Many commands
 * use exit codes to convey information other than success/failure (grep returns
 * 1 when no matches are found — not an error). Upstream extracted the base
 * command with the legacy `splitCommand_DEPRECATED` char-walker; here the caller
 * passes the base command (argv[0] of the last simple command), extracted from
 * the vendored AST parser, so this module stays a pure lookup with no parser
 * dependency.
 */

export type CommandSemantic = (exitCode: number) => {
  isError: boolean;
  message?: string;
};

/** Default semantic: only 0 is success, everything else is an error. */
const DEFAULT_SEMANTIC: CommandSemantic = (exitCode) => ({
  isError: exitCode !== 0,
  message: exitCode !== 0 ? `Command failed with exit code ${exitCode}` : undefined,
});

const COMMAND_SEMANTICS: Map<string, CommandSemantic> = new Map([
  // grep: 0=matches found, 1=no matches, 2+=error
  ['grep', (exitCode) => ({ isError: exitCode >= 2, message: exitCode === 1 ? 'No matches found' : undefined })],
  // ripgrep has the same semantics as grep
  ['rg', (exitCode) => ({ isError: exitCode >= 2, message: exitCode === 1 ? 'No matches found' : undefined })],
  // find: 0=success, 1=partial (some dirs inaccessible), 2+=error
  ['find', (exitCode) => ({ isError: exitCode >= 2, message: exitCode === 1 ? 'Some directories were inaccessible' : undefined })],
  // diff: 0=no differences, 1=differences found, 2+=error
  ['diff', (exitCode) => ({ isError: exitCode >= 2, message: exitCode === 1 ? 'Files differ' : undefined })],
  // test / [: 0=condition true, 1=condition false, 2+=error
  ['test', (exitCode) => ({ isError: exitCode >= 2, message: exitCode === 1 ? 'Condition is false' : undefined })],
  ['[', (exitCode) => ({ isError: exitCode >= 2, message: exitCode === 1 ? 'Condition is false' : undefined })],
]);

/**
 * Interpret an exit code for `baseCommand` (argv[0] of the command that set
 * `$?` — i.e. the last simple command). Unknown commands use the default
 * "non-zero = error" semantic.
 */
export function interpretExitCode(
  baseCommand: string,
  exitCode: number,
): { isError: boolean; message?: string } {
  const semantic = COMMAND_SEMANTICS.get(baseCommand) ?? DEFAULT_SEMANTIC;
  return semantic(exitCode);
}
