#!/usr/bin/env node
/**
 * nexora CLI entry point.
 *
 * Usage:
 *   nexora create agent <name> [options]    Scaffold a new agent
 *   nexora dev [options]                    Start all agents + gateway
 */

import { scaffoldAgent } from './scaffold.js';
import { runDev } from './dev.js';
import { exportPackage, importPackage } from './portability.js';
import { runDoctor, viewDlq, viewBudget, viewHandraises } from './ops.js';

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

  if (args.command === 'dev') {
    const port = typeof args.flags.port === 'string' ? parseInt(args.flags.port, 10) : 3000;
    const contextDir = typeof args.flags.context === 'string' ? args.flags.context : './context';
    const agentsDir = typeof args.flags.agents === 'string' ? args.flags.agents : './agents';
    const model = typeof args.flags.model === 'string' ? args.flags.model : 'claude-sonnet-4-5';

    await runDev({ port, contextDir, agentsDir, model });
    return;
  }

  if (args.command === 'export') {
    const output = typeof args.flags.output === 'string' ? args.flags.output : undefined;
    try {
      await exportPackage({ output });
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  if (args.command === 'import') {
    const input = args.subcommand ?? args.positional[0];
    if (!input) {
      console.error('Error: input file required');
      console.error('Usage: nexora import <file.tar.gz> [--force]');
      process.exit(1);
    }
    const force = args.flags.force === true || args.flags.force === 'true';
    try {
      await importPackage({ input, force });
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  if (args.command === 'doctor') {
    const contextDir = typeof args.flags.context === 'string' ? args.flags.context : './context';
    const agentsDir = typeof args.flags.agents === 'string' ? args.flags.agents : './agents';
    try {
      const result = await runDoctor({ contextDir, agentsDir });
      for (const check of result.checks) {
        const icon = check.status === 'pass' ? 'OK' : check.status === 'warn' ? 'WARN' : 'FAIL';
        console.log(`  [${icon}] ${check.name}: ${check.message}`);
      }
      console.log(result.ok ? '\nAll checks passed.' : '\nSome checks failed.');
      if (!result.ok) process.exit(1);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  if (args.command === 'ops') {
    const dataDir = typeof args.flags.data === 'string' ? args.flags.data : './data';
    const limit = typeof args.flags.limit === 'string' ? parseInt(args.flags.limit, 10) : 20;

    if (args.subcommand === 'dlq') {
      const entries = await viewDlq({ dataDir, limit });
      if (entries.length === 0) {
        console.log('No DLQ entries.');
      } else {
        for (const e of entries) {
          console.log(`  [${new Date(e.timestamp).toISOString()}] ${e.topic}: ${e.error}`);
        }
        console.log(`\n${entries.length} entries.`);
      }
      return;
    }

    if (args.subcommand === 'budget') {
      const summaries = await viewBudget({ dataDir });
      if (summaries.length === 0) {
        console.log('No budget data.');
      } else {
        console.log('  Scope                 Spent      Limit      Usage');
        console.log('  ' + '-'.repeat(60));
        for (const s of summaries) {
          const scope = s.scope.padEnd(20);
          const spent = `$${s.spent.toFixed(4)}`.padEnd(10);
          const limit = s.limit !== null ? `$${s.limit.toFixed(4)}`.padEnd(10) : 'unlimited'.padEnd(10);
          console.log(`  ${scope} ${spent} ${limit} ${s.utilization}`);
        }
      }
      return;
    }

    if (args.subcommand === 'handraise') {
      const entries = await viewHandraises({ dataDir });
      if (entries.length === 0) {
        console.log('No pending handraises.');
      } else {
        for (const e of entries) {
          console.log(`  [${e.id}] ${e.agentName} (${e.tenantId}): ${e.question}`);
        }
        console.log(`\n${entries.length} pending.`);
      }
      return;
    }

    console.error('Usage: nexora ops <dlq|budget|handraise> [--data <dir>]');
    process.exit(1);
    return;
  }

  console.error(`Unknown command: ${args.command} ${args.subcommand ?? ''}`);
  printHelp();
  process.exit(1);
}

function printHelp(): void {
  console.log(`nexora — multi-tenant agent framework CLI

Usage:
  nexora create agent <name> [options]    Scaffold a new agent
  nexora dev [options]                    Start all agents + gateway
  nexora doctor [options]                 Health check: agents, context, deps
  nexora ops dlq [--data <dir>]          List dead-letter queue entries
  nexora ops budget [--data <dir>]       Show budget status per scope
  nexora ops handraise [--data <dir>]    List pending handraise requests
  nexora export [--output file.tar.gz]   Bundle agents + context for sharing
  nexora import <file.tar.gz> [--force]  Unpack a shared bundle

Create options:
  --arch <name>      Architecture (react, deep-research, plan-execute, loop). Default: react
  --tools a,b,c      Comma-separated tool names. Default: read,grep
  --force            Overwrite existing directory

Dev options:
  --port <n>         HTTP port. Default: 3000
  --context <dir>    Context root directory. Default: ./context
  --agents <dir>     Agents directory. Default: ./agents
  --model <name>     Default LLM model. Default: claude-sonnet-4-5

Ops options:
  --data <dir>       Data root directory. Default: ./data
  --limit <n>        Max entries to show. Default: 20

  --help             Show this help

Examples:
  nexora create agent dev-agent --tools exec,read,grep
  nexora dev
  nexora dev --port 8080 --model claude-haiku-4-5
  nexora doctor
  nexora ops dlq
  nexora ops budget
`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
