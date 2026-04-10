#!/usr/bin/env node
/**
 * nexora CLI entry point.
 *
 * Usage:
 *   nexora create agent <name> [--arch <react|deep-research|plan-execute|loop>] [--tools a,b,c] [--force]
 */

import { scaffoldAgent } from './scaffold.js';

interface ParsedArgs {
  command: string;
  subcommand?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  let command = '';
  let subcommand: string | undefined;

  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      if (!command) command = a;
      else if (!subcommand) subcommand = a;
      else positional.push(a);
      i += 1;
    }
  }

  return { command, subcommand, positional, flags };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (!args.command || args.command === 'help' || args.flags.help) {
    printHelp();
    return;
  }

  if (args.command === 'create' && args.subcommand === 'agent') {
    const name = args.positional[0];
    if (!name) {
      console.error('Error: agent name required');
      console.error('Usage: nexora create agent <name>');
      process.exit(1);
    }

    const arch = (typeof args.flags.arch === 'string' ? args.flags.arch : 'react') as
      'react' | 'deep-research' | 'plan-execute' | 'loop';

    const toolsStr = typeof args.flags.tools === 'string' ? args.flags.tools : 'read,grep';
    const tools = toolsStr.split(',').map(s => s.trim()).filter(Boolean);

    const force = args.flags.force === true || args.flags.force === 'true';

    try {
      const result = await scaffoldAgent({ name, architecture: arch, tools, force });
      console.log(`Created agent at ${result.outDir}`);
      for (const file of result.files) console.log(`  + ${file}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown command: ${args.command} ${args.subcommand ?? ''}`);
  printHelp();
  process.exit(1);
}

function printHelp(): void {
  console.log(`nexora — multi-tenant agent framework CLI

Usage:
  nexora create agent <name> [options]

Options:
  --arch <name>      Architecture (react, deep-research, plan-execute, loop). Default: react
  --tools a,b,c      Comma-separated tool names. Default: read,grep
  --force            Overwrite existing directory
  --help             Show this help

Examples:
  nexora create agent dev-agent --tools exec,read,grep
  nexora create agent researcher --arch deep-research
`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
