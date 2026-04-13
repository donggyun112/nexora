/**
 * nexora ops — operational inspection tools.
 *
 * CLI commands for production visibility:
 *   nexora doctor          — health check: stores, transport, config
 *   nexora ops dlq         — list dead-letter queue entries
 *   nexora ops budget      — show budget status per agent/tenant
 *   nexora ops handraise   — list pending handraise requests
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';

// ─── Doctor ────────────────────────────────────────────────────────────────

export interface DoctorOptions {
  contextDir: string;
  agentsDir: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  ok: boolean;
}

export interface DoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  // 1. Check agents directory exists and has agents
  if (fs.existsSync(options.agentsDir)) {
    const entries = await fsp.readdir(options.agentsDir);
    const dirs = [];
    for (const entry of entries) {
      const stat = await fsp.stat(path.join(options.agentsDir, entry));
      if (stat.isDirectory()) dirs.push(entry);
    }
    if (dirs.length > 0) {
      checks.push({
        name: 'agents',
        status: 'pass',
        message: `Found ${dirs.length} agent(s): ${dirs.join(', ')}`,
      });
    } else {
      checks.push({
        name: 'agents',
        status: 'warn',
        message: `No agent directories in ${options.agentsDir}`,
      });
    }
  } else {
    checks.push({
      name: 'agents',
      status: 'fail',
      message: `Agents directory not found: ${options.agentsDir}`,
    });
  }

  // 2. Check context directory
  if (fs.existsSync(options.contextDir)) {
    checks.push({
      name: 'context',
      status: 'pass',
      message: `Context directory exists: ${options.contextDir}`,
    });

    // Check for personas
    const personasDir = path.join(options.contextDir, 'personas');
    if (fs.existsSync(personasDir)) {
      const personas = (await fsp.readdir(personasDir)).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
      checks.push({
        name: 'personas',
        status: personas.length > 0 ? 'pass' : 'warn',
        message: personas.length > 0
          ? `Found ${personas.length} persona(s)`
          : 'No persona files found (agents will use defaults)',
      });
    }
  } else {
    checks.push({
      name: 'context',
      status: 'warn',
      message: `Context directory not found: ${options.contextDir} (will use defaults)`,
    });
  }

  // 3. Check package.json / dependencies
  const pkgPath = path.join(process.cwd(), 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf-8')) as Record<string, unknown>;
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined) ?? {},
        ...(pkg.devDependencies as Record<string, string> | undefined) ?? {},
      };

      const required = ['@nexora/contracts', '@nexora/core'];
      for (const dep of required) {
        checks.push({
          name: `dep:${dep}`,
          status: dep in deps ? 'pass' : 'fail',
          message: dep in deps ? `${dep}: ${deps[dep]}` : `Missing required dependency: ${dep}`,
        });
      }
    } catch {
      checks.push({
        name: 'package.json',
        status: 'fail',
        message: 'Could not parse package.json',
      });
    }
  } else {
    checks.push({
      name: 'package.json',
      status: 'warn',
      message: 'No package.json found in current directory',
    });
  }

  // 4. Check Node version
  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split('.')[0], 10);
  checks.push({
    name: 'node',
    status: major >= 18 ? 'pass' : 'fail',
    message: `Node.js ${nodeVersion}${major < 18 ? ' (need >= 18)' : ''}`,
  });

  const ok = checks.every(c => c.status !== 'fail');
  return { checks, ok };
}

// ─── DLQ Viewer ────────────────────────────────────────────────────────────

export interface DlqViewOptions {
  dataDir: string;
  limit?: number;
}

export interface DlqEntry {
  id: string;
  topic: string;
  error: string;
  timestamp: number;
  payload: unknown;
}

export async function viewDlq(options: DlqViewOptions): Promise<DlqEntry[]> {
  const dlqDir = path.join(options.dataDir, 'dlq');
  if (!fs.existsSync(dlqDir)) return [];

  const files = (await fsp.readdir(dlqDir)).filter(f => f.endsWith('.json'));
  const entries: DlqEntry[] = [];

  for (const file of files) {
    try {
      const content = await fsp.readFile(path.join(dlqDir, file), 'utf-8');
      const entry = JSON.parse(content) as DlqEntry;
      entries.push(entry);
    } catch {
      // skip malformed entries
    }
  }

  entries.sort((a, b) => b.timestamp - a.timestamp);
  return options.limit ? entries.slice(0, options.limit) : entries;
}

// ─── Budget Status ─────────────────────────────────────────────────────────

export interface BudgetViewOptions {
  dataDir: string;
}

export interface BudgetSummary {
  scope: string;
  spent: number;
  limit: number | null;
  utilization: string;
}

export async function viewBudget(options: BudgetViewOptions): Promise<BudgetSummary[]> {
  const budgetDir = path.join(options.dataDir, 'budget');
  if (!fs.existsSync(budgetDir)) return [];

  const files = (await fsp.readdir(budgetDir)).filter(f => f.endsWith('.json'));
  const summaries: BudgetSummary[] = [];

  for (const file of files) {
    try {
      const content = await fsp.readFile(path.join(budgetDir, file), 'utf-8');
      const data = JSON.parse(content) as {
        scope?: string;
        totalSpent?: number;
        limit?: number | null;
      };
      const scope = data.scope ?? path.basename(file, '.json');
      const spent = data.totalSpent ?? 0;
      const limit = data.limit ?? null;
      const utilization = limit !== null && limit > 0
        ? `${((spent / limit) * 100).toFixed(1)}%`
        : 'unlimited';
      summaries.push({ scope, spent, limit, utilization });
    } catch {
      // skip malformed
    }
  }

  return summaries.sort((a, b) => b.spent - a.spent);
}

// ─── Handraise Inbox ───────────────────────────────────────────────────────

export interface HandraiseViewOptions {
  dataDir: string;
}

export interface HandraiseEntry {
  id: string;
  agentName: string;
  question: string;
  tenantId: string;
  timestamp: number;
  status: 'pending' | 'resolved';
}

export async function viewHandraises(options: HandraiseViewOptions): Promise<HandraiseEntry[]> {
  const hrDir = path.join(options.dataDir, 'handraises');
  if (!fs.existsSync(hrDir)) return [];

  const files = (await fsp.readdir(hrDir)).filter(f => f.endsWith('.json'));
  const entries: HandraiseEntry[] = [];

  for (const file of files) {
    try {
      const content = await fsp.readFile(path.join(hrDir, file), 'utf-8');
      const entry = JSON.parse(content) as HandraiseEntry;
      entries.push(entry);
    } catch {
      // skip malformed
    }
  }

  return entries
    .filter(e => e.status === 'pending')
    .sort((a, b) => a.timestamp - b.timestamp);
}
