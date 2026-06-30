/**
 * Parse wrapper over the vendored pure-TS bash parser (bash-parser.ts).
 *
 * Vendored from claude-code `utils/bash/parser.ts`. Upstream gated parsing
 * behind `bun:bundle` feature flags and fired analytics on load; the parser is
 * now pure TypeScript (no native/WASM dependency), so this wrapper runs it
 * unconditionally and drops the feature gates and telemetry. The tree walk
 * (findCommandNode / extractEnvVars / extractCommandArguments) is verbatim.
 */

import {
  ensureParserInitialized,
  getParserModule,
  type TsNode,
} from './bash-parser.js';

export type Node = TsNode;

export interface ParsedCommandData {
  rootNode: Node;
  envVars: string[];
  commandNode: Node | null;
  originalCommand: string;
}

const MAX_COMMAND_LENGTH = 10000;
const DECLARATION_COMMANDS = new Set([
  'export',
  'declare',
  'typeset',
  'readonly',
  'local',
  'unset',
  'unsetenv',
]);
const ARGUMENT_TYPES = new Set(['word', 'string', 'raw_string', 'number']);
const SUBSTITUTION_TYPES = new Set([
  'command_substitution',
  'process_substitution',
]);
const COMMAND_TYPES = new Set(['command', 'declaration_command']);

/**
 * Awaits parser init. No-op for the pure-TS parser (kept for API symmetry with
 * the upstream WASM path). Idempotent.
 */
export async function ensureInitialized(): Promise<void> {
  await ensureParserInitialized();
}

export async function parseCommand(
  command: string,
): Promise<ParsedCommandData | null> {
  if (!command || command.length > MAX_COMMAND_LENGTH) return null;

  await ensureParserInitialized();
  const mod = getParserModule();
  if (!mod) return null;

  try {
    const rootNode = mod.parse(command);
    if (!rootNode) return null;

    const commandNode = findCommandNode(rootNode, null);
    const envVars = extractEnvVars(commandNode);

    return { rootNode, envVars, commandNode, originalCommand: command };
  } catch {
    return null;
  }
}

/**
 * SECURITY: Sentinel for "parser was loaded and attempted, but aborted"
 * (timeout / node budget / panic). Distinct from `null` (empty/over-length).
 * Adversarial input can trigger abort under MAX_COMMAND_LENGTH. Callers MUST
 * treat this as fail-closed (too-complex), NOT route to a permissive path.
 */
export const PARSE_ABORTED = Symbol('parse-aborted');

/**
 * Raw parse — skips findCommandNode/extractEnvVars which the security walker in
 * bash-ast.ts doesn't use. Saves one tree walk per bash command.
 *
 * Returns:
 *   - Node: parse succeeded
 *   - null: empty / over-length
 *   - PARSE_ABORTED: parser ran but the parse aborted (timeout/node-budget)
 */
export async function parseCommandRaw(
  command: string,
): Promise<Node | null | typeof PARSE_ABORTED> {
  if (!command || command.length > MAX_COMMAND_LENGTH) return null;
  await ensureParserInitialized();
  const mod = getParserModule();
  if (!mod) return null;
  try {
    const result = mod.parse(command);
    // Module loaded; null here = timeout/node-budget abort in bash-parser.ts.
    // Must fail closed (too-complex), not fall through to a permissive path.
    if (result === null) return PARSE_ABORTED;
    return result;
  } catch {
    return PARSE_ABORTED;
  }
}

function findCommandNode(node: Node, parent: Node | null): Node | null {
  const { type, children } = node;

  if (COMMAND_TYPES.has(type)) return node;

  // Variable assignment followed by command
  if (type === 'variable_assignment' && parent) {
    return (
      parent.children.find(
        c => COMMAND_TYPES.has(c.type) && c.startIndex > node.startIndex,
      ) ?? null
    );
  }

  // Pipeline: recurse into first child (which may be a redirected_statement)
  if (type === 'pipeline') {
    for (const child of children) {
      const result = findCommandNode(child, node);
      if (result) return result;
    }
    return null;
  }

  // Redirected statement: find the command inside
  if (type === 'redirected_statement') {
    return children.find(c => COMMAND_TYPES.has(c.type)) ?? null;
  }

  // Recursive search
  for (const child of children) {
    const result = findCommandNode(child, node);
    if (result) return result;
  }

  return null;
}

function extractEnvVars(commandNode: Node | null): string[] {
  if (!commandNode || commandNode.type !== 'command') return [];

  const envVars: string[] = [];
  for (const child of commandNode.children) {
    if (child.type === 'variable_assignment') {
      envVars.push(child.text);
    } else if (child.type === 'command_name' || child.type === 'word') {
      break;
    }
  }
  return envVars;
}

export function extractCommandArguments(commandNode: Node): string[] {
  // Declaration commands
  if (commandNode.type === 'declaration_command') {
    const firstChild = commandNode.children[0];
    return firstChild && DECLARATION_COMMANDS.has(firstChild.text)
      ? [firstChild.text]
      : [];
  }

  const args: string[] = [];
  let foundCommandName = false;

  for (const child of commandNode.children) {
    if (child.type === 'variable_assignment') continue;

    // Command name
    if (
      child.type === 'command_name' ||
      (!foundCommandName && child.type === 'word')
    ) {
      foundCommandName = true;
      args.push(child.text);
      continue;
    }

    // Arguments
    if (ARGUMENT_TYPES.has(child.type)) {
      args.push(stripQuotes(child.text));
    } else if (SUBSTITUTION_TYPES.has(child.type)) {
      break;
    }
  }
  return args;
}

function stripQuotes(text: string): string {
  return text.length >= 2 &&
    ((text[0] === '"' && text.at(-1) === '"') ||
      (text[0] === "'" && text.at(-1) === "'"))
    ? text.slice(1, -1)
    : text;
}
