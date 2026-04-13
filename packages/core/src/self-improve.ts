/**
 * Self-Improvement Engine — agents learn from execution results.
 *
 * Philosophy: "Honest agents learn from their limits."
 *
 * Three layers, each from a different reference:
 *
 * 1. ExecutionTracker + ResultsLedger (AutoAgent)
 *    - Persistent TSV ledger of every run (not just in-memory)
 *    - Keep/discard framework with overfitting guard
 *    - "One change at a time" discipline
 *
 * 2. SafeSkillWriter (Hermes skill_manager_tool.py)
 *    - Atomic writes (temp file → rename)
 *    - Security scanning (threat pattern blocklist)
 *    - Size limits (100K chars)
 *    - Name collision detection
 *    - Frontmatter validation before persist
 *    - Patch action (not just create)
 *
 * 3. LearningEngine (auto-work-flow knowledge.tool + pm-memory)
 *    - Structured skill extraction with schema validation
 *    - Decision logging (persistent, not transient)
 *    - Evaluation grading (pass/fail with retry)
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type {
  AgentEvent,
  AgentInput,
  AgentLogger,
  LLMProvider,
  LLMUsage,
} from '@nexora/contracts';

// ─── Constants ─────────────────────────────────────────────────────────

const MAX_SKILL_CONTENT_CHARS = 100_000;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Threat patterns in agent-generated skill content.
 * Based on Hermes skills_guard (70+ patterns).
 * Blocks shell injection, exfiltration, destructive commands, reverse shells.
 */
const THREAT_PATTERNS: RegExp[] = [
  // Shell injection (NOT backticks — those are valid Markdown code)
  /\$\([^)]+\)/,
  /\beval\s*\(/,
  /\bexec\s*\(/,
  /\bchild_process\b/,
  /\bspawn\s*\(/,
  // Exfiltration
  /\bcurl\s+.*-d\b/,
  /\bwget\s+.*--post/,
  /\bfetch\s*\(.*method.*POST/i,
  /process\.env\[/,
  // Destructive
  /\brm\s+-rf\s+\//,
  /\brmdir\b.*\/\b/,
  /DROP\s+TABLE/i,
  /DELETE\s+FROM/i,
  /TRUNCATE\s+/i,
  // Reverse shell
  /\bnc\s+-[elp]/,
  /\/dev\/tcp\//,
  /\bmkfifo\b/,
  /\bsocat\b.*exec/i,
  // Path traversal
  /\.\.\//,
  /\.\.\\/,
  // Credential access
  /\/etc\/passwd/,
  /\/etc\/shadow/,
  /\.ssh\/id_/,
  /AWS_SECRET/i,
  /ANTHROPIC_API_KEY/i,
  /OPENAI_API_KEY/i,
];

// ─── Types ─────────────────────────────────────────────────────────────

export interface ExecutionRecord {
  agentName: string;
  input: string;
  events: AgentEvent[];
  result: string;
  success: boolean;
  error?: string;
  usage?: LLMUsage;
  durationMs: number;
  timestamp: number;
  usedHandraise: boolean;
  toolsCalled: string[];
}

/** AutoAgent-style results ledger entry */
export interface LedgerEntry {
  timestamp: number;
  agentName: string;
  success: boolean;
  score: number;
  passed: string;
  error: string;
  skillAction: string;
  description: string;
}

export interface LearningOutcome {
  type: 'skill-created' | 'skill-patched' | 'knowledge-saved' | 'discarded' | 'no-action';
  description: string;
  name?: string;
  /** AutoAgent keep/discard decision */
  decision?: 'keep' | 'discard';
  reason?: string;
}

export interface PerformanceSnapshot {
  since: number;
  total: number;
  succeeded: number;
  successRate: number;
  avgDurationMs: number;
  totalCostUsd: number;
  failurePatterns: Array<{ pattern: string; count: number }>;
  topTools: Array<{ name: string; count: number }>;
}

// ─── Security Scanner (Hermes skills_guard) ────────────────────────────

/**
 * Scan skill content for threat patterns.
 * Returns null if safe, error message if blocked.
 */
export function scanSkillContent(content: string): string | null {
  for (const pattern of THREAT_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      return `Blocked: skill content matches threat pattern "${pattern.source}" near "${match[0].slice(0, 50)}"`;
    }
  }
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return `Blocked: skill content exceeds ${MAX_SKILL_CONTENT_CHARS} chars (got ${content.length})`;
  }
  return null;
}

// ─── Frontmatter Validation ────────────────────────────────────────────

/**
 * Validate SKILL.md has proper frontmatter with required fields.
 * Returns extracted name or throws.
 */
/**
 * Validate SKILL.md has proper frontmatter matching the actual SkillFrontmatter schema.
 * Checks: name (required, regex), description (required), version, author, tags.
 */
export function validateSkillFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error('Invalid SKILL.md: missing frontmatter (---\\n...\\n---)');
  }

  const fm = match[1];
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  const versionMatch = fm.match(/^version:\s*(.+)$/m);
  const authorMatch = fm.match(/^author:\s*(.+)$/m);

  if (!nameMatch) throw new Error('Invalid SKILL.md: missing "name" in frontmatter');
  if (!descMatch) throw new Error('Invalid SKILL.md: missing "description" in frontmatter');

  const name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
  const description = descMatch[1].trim().replace(/^["']|["']$/g, '');

  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name "${name}": must match ${SKILL_NAME_RE}`);
  }

  // Warn but don't fail on missing optional fields (LLM may omit them)
  if (!versionMatch) {
    // Version defaults to 1 in the loader, so this is fine
  }
  if (authorMatch) {
    const author = authorMatch[1].trim();
    if (author !== 'system' && author !== 'agent') {
      throw new Error(`Invalid author "${author}": must be "system" or "agent"`);
    }
  }

  return { name, description };
}

// ─── Safe Skill Writer (Hermes atomic write + security) ────────────────

export interface SafeSkillWriterOptions {
  /** Root directory for agent-created skills */
  skillsDir: string;
  /** Optional: callback when skill cache should be invalidated */
  onCacheInvalidate?: () => void;
  logger?: AgentLogger;
}

/**
 * Writes skills safely with all Hermes guarantees:
 * - Atomic write (temp file → rename)
 * - Security scan before persist
 * - Size limits
 * - Frontmatter validation
 * - Name collision detection
 * - Patch support (not just create)
 */
export class SafeSkillWriter {
  private readonly skillsDir: string;
  private readonly onCacheInvalidate?: () => void;
  private readonly logger: AgentLogger;

  constructor(options: SafeSkillWriterOptions) {
    this.skillsDir = options.skillsDir;
    this.onCacheInvalidate = options.onCacheInvalidate;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /**
   * Create a new skill. Validates, scans, writes atomically.
   * Returns the skill name or throws.
   */
  async create(content: string): Promise<string> {
    // 1. Validate frontmatter
    const { name } = validateSkillFrontmatter(content);

    // 2. Security scan
    const threat = scanSkillContent(content);
    if (threat) throw new Error(threat);

    // 3. Name collision detection
    const skillDir = path.join(this.skillsDir, name);
    if (fs.existsSync(skillDir)) {
      throw new Error(`Skill "${name}" already exists at ${skillDir}. Use patch() instead.`);
    }

    // 4. Path containment check
    const resolved = path.resolve(skillDir);
    const root = path.resolve(this.skillsDir);
    if (!resolved.startsWith(root + path.sep)) {
      throw new Error(`Skill name "${name}" resolves outside skills directory`);
    }

    // 5. Atomic write: mkdir → write to temp → rename
    await fsp.mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    await atomicWrite(skillFile, content);

    // 6. Invalidate cache
    this.onCacheInvalidate?.();
    this.logger.info(`Skill created: ${name}`);
    return name;
  }

  /**
   * Patch an existing skill: find oldText, replace with newText.
   * More surgical than full rewrite — preserves surrounding content.
   */
  async patch(name: string, oldText: string, newText: string): Promise<void> {
    // Validate name (same as create — prevents path traversal)
    if (!SKILL_NAME_RE.test(name)) {
      throw new Error(`Invalid skill name for patch: "${name}"`);
    }
    const skillDir = path.join(this.skillsDir, name);
    const resolved = path.resolve(skillDir);
    const root = path.resolve(this.skillsDir);
    if (!resolved.startsWith(root + path.sep)) {
      throw new Error(`Skill name "${name}" resolves outside skills directory`);
    }

    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      throw new Error(`Skill "${name}" not found for patching`);
    }

    const current = await fsp.readFile(skillFile, 'utf-8');

    // Try exact match first
    if (current.includes(oldText)) {
      const patched = current.replace(oldText, newText);
      await this.validateAndWritePatch(skillFile, patched);
      return;
    }

    // Fuzzy match: normalize whitespace for comparison
    const normalizedCurrent = current.replace(/\s+/g, ' ');
    const normalizedOld = oldText.replace(/\s+/g, ' ');
    if (!normalizedCurrent.includes(normalizedOld)) {
      throw new Error(`Patch target not found in skill "${name}"`);
    }

    // Build fuzzy regex: escape special chars FIRST, then replace literal whitespace
    const escaped = oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fuzzyPattern = escaped.replace(/\s+/g, '\\s+');
    const patched = current.replace(new RegExp(fuzzyPattern), newText);
    await this.validateAndWritePatch(skillFile, patched);
  }

  /** Delete a skill directory (for discard rollback) */
  async delete(name: string): Promise<void> {
    if (!SKILL_NAME_RE.test(name)) return;
    const skillDir = path.join(this.skillsDir, name);
    const resolved = path.resolve(skillDir);
    const root = path.resolve(this.skillsDir);
    if (!resolved.startsWith(root + path.sep)) return;
    if (fs.existsSync(skillDir)) {
      await fsp.rm(skillDir, { recursive: true, force: true });
      this.onCacheInvalidate?.();
      this.logger.info(`Skill deleted: ${name}`);
    }
  }

  private async validateAndWritePatch(skillFile: string, patched: string): Promise<void> {
    validateSkillFrontmatter(patched);
    const threat = scanSkillContent(patched);
    if (threat) throw new Error(`Patch blocked: ${threat}`);
    await atomicWrite(skillFile, patched);
    this.onCacheInvalidate?.();
  }

  /** Check if a skill name already exists */
  exists(name: string): boolean {
    return fs.existsSync(path.join(this.skillsDir, name, 'SKILL.md'));
  }
}

/** Atomic write: write to temp file, then rename. Prevents corruption on crash. */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpFile = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}`);
  try {
    await fsp.writeFile(tmpFile, content, 'utf-8');
    await fsp.rename(tmpFile, filePath);
  } catch (err) {
    try { await fsp.unlink(tmpFile); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

// ─── Results Ledger (AutoAgent results.tsv) ────────────────────────────

/**
 * Persistent TSV ledger of all execution results and learning decisions.
 * Survives process restart. One line per execution.
 */
export class ResultsLedger {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async append(entry: LedgerEntry): Promise<void> {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) await fsp.mkdir(dir, { recursive: true });

    const header = 'timestamp\tagent\tsuccess\tscore\tpassed\terror\tskill_action\tdescription\n';
    if (!fs.existsSync(this.filePath)) {
      await fsp.writeFile(this.filePath, header, 'utf-8');
    }

    const line = [
      entry.timestamp,
      entry.agentName,
      entry.success,
      entry.score.toFixed(4),
      entry.passed,
      entry.error.replace(/\t/g, ' ').replace(/\n/g, ' ').slice(0, 200),
      entry.skillAction,
      entry.description.replace(/\t/g, ' ').replace(/\n/g, ' ').slice(0, 200),
    ].join('\t') + '\n';

    fs.appendFileSync(this.filePath, line, 'utf-8');
  }

  async readAll(): Promise<LedgerEntry[]> {
    if (!fs.existsSync(this.filePath)) return [];
    const content = await fsp.readFile(this.filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('timestamp'));
    return lines.map(line => {
      const [ts, agent, success, score, passed, error, action, desc] = line.split('\t');
      return {
        timestamp: parseInt(ts, 10),
        agentName: agent,
        success: success === 'true',
        score: parseFloat(score),
        passed,
        error: error ?? '',
        skillAction: action ?? 'no-action',
        description: desc ?? '',
      };
    });
  }

  /** Get recent entries for keep/discard baseline comparison */
  async getBaseline(limit = 10): Promise<LedgerEntry[]> {
    const all = await this.readAll();
    return all.filter(e => e.skillAction !== 'discarded').slice(-limit);
  }
}

// ─── Execution Tracker ─────────────────────────────────────────────────

export class ExecutionTracker {
  private records: ExecutionRecord[] = [];
  private readonly maxRecords: number;

  constructor(options?: { maxRecords?: number }) {
    this.maxRecords = options?.maxRecords ?? 1000;
  }

  record(record: ExecutionRecord): void {
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }

  static fromEvents(
    agentName: string,
    input: AgentInput,
    events: AgentEvent[],
    durationMs: number,
  ): ExecutionRecord {
    const doneEvent = events.find(e => e.type === 'done');
    const errorEvent = events.find(e => e.type === 'error');
    const toolCalls = events
      .filter(e => e.type === 'tool_call')
      .map(e => (e as { name: string }).name);

    return {
      agentName,
      input: input.prompt,
      events,
      result: doneEvent?.type === 'done' ? doneEvent.content : '',
      success: !!doneEvent && !errorEvent,
      error: errorEvent?.type === 'error' ? errorEvent.message : undefined,
      durationMs,
      timestamp: Date.now(),
      usedHandraise: toolCalls.includes('handraise'),
      toolsCalled: [...new Set(toolCalls)],
    };
  }

  getSnapshot(sinceMs?: number): PerformanceSnapshot {
    const since = sinceMs ?? Date.now() - 24 * 60 * 60 * 1000;
    const recent = this.records.filter(r => r.timestamp >= since);
    const succeeded = recent.filter(r => r.success).length;
    const avgDuration = recent.length > 0
      ? recent.reduce((s, r) => s + r.durationMs, 0) / recent.length : 0;
    const totalCost = recent.reduce((s, r) => {
      if (!r.usage) return s;
      return s + (r.usage.promptTokens * 3 + r.usage.completionTokens * 15) / 1_000_000;
    }, 0);

    const failureCounts = new Map<string, number>();
    for (const r of recent.filter(r => !r.success)) {
      const p = categorizeFailure(r);
      failureCounts.set(p, (failureCounts.get(p) ?? 0) + 1);
    }
    const toolCounts = new Map<string, number>();
    for (const r of recent) {
      for (const t of r.toolsCalled) toolCounts.set(t, (toolCounts.get(t) ?? 0) + 1);
    }

    return {
      since, total: recent.length, succeeded,
      successRate: recent.length > 0 ? succeeded / recent.length : 0,
      avgDurationMs: avgDuration, totalCostUsd: totalCost,
      failurePatterns: [...failureCounts.entries()]
        .map(([pattern, count]) => ({ pattern, count }))
        .sort((a, b) => b.count - a.count).slice(0, 10),
      topTools: [...toolCounts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count).slice(0, 10),
    };
  }

  getRecords(): readonly ExecutionRecord[] { return this.records; }
  getRecentFailures(limit = 10): ExecutionRecord[] {
    return this.records.filter(r => !r.success).slice(-limit);
  }
}

// ─── Learning Engine ───────────────────────────────────────────────────

export interface LearningEngineOptions {
  llm: LLMProvider;
  /** Safe skill writer (with atomic write + security scan) */
  skillWriter: SafeSkillWriter;
  /** Knowledge save callback */
  onKnowledgeSave?: (topic: string, content: string) => Promise<void>;
  /** Decision log callback — persists learning decisions */
  onDecisionLog?: (decision: string) => Promise<void>;
  /** Results ledger for keep/discard tracking */
  ledger?: ResultsLedger;
  minToolCallsForSkill?: number;
  logger?: AgentLogger;
}

export class LearningEngine {
  private readonly llm: LLMProvider;
  private readonly skillWriter: SafeSkillWriter;
  private readonly onKnowledgeSave: LearningEngineOptions['onKnowledgeSave'];
  private readonly onDecisionLog: LearningEngineOptions['onDecisionLog'];
  private readonly ledger?: ResultsLedger;
  private readonly minToolCalls: number;
  private readonly logger: AgentLogger;

  constructor(options: LearningEngineOptions) {
    this.llm = options.llm;
    this.skillWriter = options.skillWriter;
    this.onKnowledgeSave = options.onKnowledgeSave;
    this.onDecisionLog = options.onDecisionLog;
    this.ledger = options.ledger;
    this.minToolCalls = options.minToolCallsForSkill ?? 5;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  async analyze(record: ExecutionRecord): Promise<LearningOutcome> {
    // Complex success → extract skill
    if (record.success && record.toolsCalled.length >= this.minToolCalls) {
      return this.learnFromSuccess(record);
    }
    // Failure → prevention skill
    if (!record.success && record.error) {
      return this.learnFromFailure(record);
    }
    // Handraise answered → knowledge
    if (record.usedHandraise && record.success) {
      return this.learnFromHandraise(record);
    }
    return { type: 'no-action', description: 'No learning signal' };
  }

  /**
   * Evaluate a learning outcome: should we keep or discard?
   * AutoAgent overfitting guard: "If this exact task disappeared,
   * would this still be a worthwhile improvement?"
   */
  /**
   * Evaluate keep/discard. If discard, ACTUALLY DELETE the created skill.
   * AutoAgent rules: improved → keep, same + general → keep, else → discard + rollback.
   */
  async evaluateAndDecide(
    outcome: LearningOutcome,
    record: ExecutionRecord,
    baselineRate: number,
    currentRate: number,
  ): Promise<LearningOutcome> {
    if (outcome.type === 'no-action') return outcome;

    if (currentRate > baselineRate) {
      outcome.decision = 'keep';
      outcome.reason = `Success rate improved: ${(baselineRate * 100).toFixed(1)}% → ${(currentRate * 100).toFixed(1)}%`;
    } else if (currentRate >= baselineRate - 0.01) {
      // Same rate (within 1% tolerance): check if generally useful
      const isGeneral = await this.checkGenerality(outcome, record);
      outcome.decision = isGeneral ? 'keep' : 'discard';
      outcome.reason = isGeneral
        ? 'Same rate but skill is generally applicable'
        : 'Same rate and skill appears task-specific (overfitting)';
    } else {
      outcome.decision = 'discard';
      outcome.reason = `Success rate dropped: ${(baselineRate * 100).toFixed(1)}% → ${(currentRate * 100).toFixed(1)}%`;
    }

    // ROLLBACK on discard: actually delete the created skill
    if (outcome.decision === 'discard' && outcome.name) {
      try {
        await this.skillWriter.delete(outcome.name);
        this.logger.info(`Skill "${outcome.name}" discarded and deleted`);
      } catch {
        this.logger.warn(`Failed to delete discarded skill "${outcome.name}"`);
      }
      outcome.type = 'discarded';
    }

    // Log decision
    if (this.ledger) {
      await this.ledger.append({
        timestamp: Date.now(),
        agentName: record.agentName,
        success: record.success,
        score: currentRate,
        passed: `${Math.round(currentRate * 100)}%`,
        error: record.error ?? '',
        skillAction: outcome.decision === 'keep' ? outcome.type : 'discarded',
        description: outcome.reason,
      });
    }

    if (this.onDecisionLog) {
      await this.onDecisionLog(
        `[${outcome.decision}] ${outcome.type}: ${outcome.description} — ${outcome.reason}`,
      ).catch(() => {});
    }

    return outcome;
  }

  async reflect(snapshot: PerformanceSnapshot): Promise<string> {
    if (snapshot.total < 5) return 'Not enough data for reflection.';

    const prompt = `You are analyzing an AI agent team's recent performance.

Performance: ${snapshot.total} executions, ${(snapshot.successRate * 100).toFixed(1)}% success, avg ${(snapshot.avgDurationMs / 1000).toFixed(1)}s, $${snapshot.totalCostUsd.toFixed(4)} total cost.

Failure patterns:
${snapshot.failurePatterns.map(f => `- ${f.pattern} (${f.count}x)`).join('\n') || '(none)'}

Top tools: ${snapshot.topTools.map(t => `${t.name}(${t.count})`).join(', ') || '(none)'}

Provide:
1. Single most impactful improvement
2. Missing skills/tools suggested by failure patterns
3. Cost/performance assessment
Under 200 words. Actionable only.`;

    const response = await this.llm.complete([{ role: 'user', content: prompt }], { maxTokens: 500 });
    return response.content;
  }

  private async learnFromSuccess(record: ExecutionRecord): Promise<LearningOutcome> {
    const prompt = `An AI agent successfully completed a complex task.

Task: ${record.input.slice(0, 500)}
Tools used (in order): ${record.toolsCalled.join(' → ')}
Result: ${record.result.slice(0, 500)}

Create a reusable SKILL.md. REQUIRED format:
---
name: kebab-case-name
description: One line description
tags: [relevant, tags]
version: 1
author: agent
---

# Skill Title

## Steps
1. Step one
2. Step two
...

Output ONLY the SKILL.md content. Nothing else.`;

    try {
      const response = await this.llm.complete([{ role: 'user', content: prompt }], { maxTokens: 1500 });
      const content = response.content;

      // Validate before writing
      const { name } = validateSkillFrontmatter(content);

      // Check if skill already exists → patch instead
      if (this.skillWriter.exists(name)) {
        this.logger.info(`Skill "${name}" already exists, skipping duplicate`);
        return { type: 'no-action', description: `Skill "${name}" already exists` };
      }

      // Safe write (atomic + security scan + size limit)
      await this.skillWriter.create(content);

      return {
        type: 'skill-created',
        description: `Extracted skill "${name}" from ${record.toolsCalled.length}-tool task`,
        name,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Skill extraction failed: ${msg}`);
      return { type: 'no-action', description: `Skill extraction failed: ${msg}` };
    }
  }

  private async learnFromFailure(record: ExecutionRecord): Promise<LearningOutcome> {
    const prompt = `An AI agent FAILED a task.

Task: ${record.input.slice(0, 500)}
Error: ${record.error?.slice(0, 300)}
Tools attempted: ${record.toolsCalled.join(', ')}

Create a PREVENTION skill. REQUIRED format:
---
name: prevent-kebab-case-name
description: Prevents [specific failure type]
tags: [prevention, error-handling]
version: 1
author: agent
---

# Preventing [Failure Type]

## Root Cause
[What went wrong]

## Prevention Steps
1. Before attempting this type of task, check...
2. If you encounter..., do...

## Correct Approach
[How to handle this correctly]

Output ONLY the SKILL.md content. Nothing else.`;

    try {
      const response = await this.llm.complete([{ role: 'user', content: prompt }], { maxTokens: 1500 });
      const content = response.content;

      const { name } = validateSkillFrontmatter(content);
      if (this.skillWriter.exists(name)) {
        return { type: 'no-action', description: `Prevention skill "${name}" already exists` };
      }

      await this.skillWriter.create(content);
      return {
        type: 'skill-created',
        description: `Prevention skill "${name}" from failure: ${record.error?.slice(0, 80)}`,
        name,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Prevention skill creation failed: ${msg}`);
      return { type: 'no-action', description: `Prevention skill failed: ${msg}` };
    }
  }

  private async learnFromHandraise(record: ExecutionRecord): Promise<LearningOutcome> {
    if (!this.onKnowledgeSave) {
      return { type: 'no-action', description: 'Knowledge save not configured' };
    }

    const topic = `handraise-${record.agentName}-${Date.now()}`;
    const content = [
      `# Learned from handraise`,
      ``,
      `**Agent:** ${record.agentName}`,
      `**Date:** ${new Date(record.timestamp).toISOString()}`,
      `**Question context:** ${record.input.slice(0, 500)}`,
      ``,
      `**Answer:** ${record.result.slice(0, 2000)}`,
    ].join('\n');

    try {
      await this.onKnowledgeSave(topic, content);
      return { type: 'knowledge-saved', description: `Saved handraise answer: ${topic}`, name: topic };
    } catch (err) {
      return { type: 'no-action', description: `Knowledge save failed: ${err}` };
    }
  }

  /** Overfitting check: would this skill be useful beyond this specific task? */
  /**
   * Overfitting guard: would this skill be useful beyond this specific task?
   * AutoAgent: "If this exact task disappeared, would this still be worthwhile?"
   */
  private async checkGenerality(outcome: LearningOutcome, record: ExecutionRecord): Promise<boolean> {
    const prompt = `A skill was created from a specific task. Determine if it would be useful for OTHER similar tasks, or if it only helps this exact task.

Skill name: ${outcome.name ?? '(unnamed)'}
Skill description: ${outcome.description}
Original task: ${record.input.slice(0, 300)}

Would this skill help with OTHER tasks beyond this specific one?
Answer ONLY "YES" or "NO".`;

    try {
      const response = await this.llm.complete([{ role: 'user', content: prompt }], { maxTokens: 5 });
      const answer = response.content.trim().toUpperCase();
      // Strict: only YES counts as general. NO, NOT, or anything else → specific
      return answer === 'YES';
    } catch {
      // On LLM failure, default to DISCARD (conservative — don't accumulate junk)
      return false;
    }
  }
}

// ─── Improvement Loop ──────────────────────────────────────────────────

export interface ImprovementLoopOptions {
  tracker: ExecutionTracker;
  learner: LearningEngine;
  logger?: AgentLogger;
  autoLearn?: boolean;
  reflectionIntervalMs?: number;
}

export function createImprovementLoop(options: ImprovementLoopOptions) {
  const { tracker, learner } = options;
  const autoLearn = options.autoLearn ?? true;
  const logger = options.logger ?? NOOP_LOGGER;
  let reflectionTimer: ReturnType<typeof setInterval> | null = null;
  const reflectionInterval = options.reflectionIntervalMs ?? 24 * 60 * 60 * 1000;

  if (reflectionInterval > 0) {
    reflectionTimer = setInterval(async () => {
      try {
        const snapshot = tracker.getSnapshot();
        const insights = await learner.reflect(snapshot);
        logger.info('Self-improvement reflection', { insights });
      } catch { /* non-critical */ }
    }, reflectionInterval);
  }

  return {
    async recordAndLearn(record: ExecutionRecord): Promise<LearningOutcome> {
      tracker.record(record);
      if (!autoLearn) return { type: 'no-action', description: 'Auto-learn disabled' };

      const outcome = await learner.analyze(record);

      // Keep/discard: compare non-overlapping windows
      // Current window: last hour. Baseline: the hour BEFORE that (no overlap).
      const now = Date.now();
      const currentRecords = tracker.getRecords().filter(
        r => r.timestamp >= now - 3600_000,
      );
      const baselineRecords = tracker.getRecords().filter(
        r => r.timestamp >= now - 7200_000 && r.timestamp < now - 3600_000,
      );
      const currentRate = currentRecords.length > 0
        ? currentRecords.filter(r => r.success).length / currentRecords.length
        : 0.5;
      const baselineRate = baselineRecords.length > 0
        ? baselineRecords.filter(r => r.success).length / baselineRecords.length
        : 0.5;

      return learner.evaluateAndDecide(outcome, record, baselineRate, currentRate);
    },

    async reflect(): Promise<string> {
      return learner.reflect(tracker.getSnapshot());
    },

    getSnapshot(sinceMs?: number): PerformanceSnapshot {
      return tracker.getSnapshot(sinceMs);
    },

    stop(): void {
      if (reflectionTimer) { clearInterval(reflectionTimer); reflectionTimer = null; }
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

function categorizeFailure(record: ExecutionRecord): string {
  const err = record.error?.toLowerCase() ?? '';
  if (err.includes('timeout') || err.includes('idle')) return 'timeout';
  if (err.includes('budget') || err.includes('exceeded')) return 'budget-exceeded';
  if (err.includes('abort')) return 'aborted';
  if (err.includes('tool') && err.includes('not found')) return 'missing-tool';
  if (err.includes('rate limit') || err.includes('429')) return 'rate-limited';
  if (err.includes('auth') || err.includes('401') || err.includes('403')) return 'auth-error';
  if (err.includes('schema') || err.includes('validation')) return 'schema-error';
  if (record.toolsCalled.length === 0) return 'no-tools-used';
  return 'unknown';
}

const NOOP_LOGGER: AgentLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
};
