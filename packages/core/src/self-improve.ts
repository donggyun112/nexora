/**
 * Self-Improvement Engine — agents learn from execution results.
 *
 * Philosophy: "Honest agents learn from their limits."
 * - Failed → analyze root cause → save as skill (prevent repeat)
 * - Succeeded → extract approach → save as skill (replicate faster)
 * - Handraise answered → save human answer as knowledge (don't ask again)
 * - Budget exceeded → record pattern → optimize next time
 *
 * Three feedback loops:
 * 1. Execution Loop — after each agent run, evaluate and learn
 * 2. Reflection Loop — periodic review of recent performance
 * 3. Improvement Loop — meta-agent improves agent configuration
 *
 * Based on:
 * - AutoAgent: baseline → analyze → improve → verify → keep/discard
 * - Hermes: skill_manage (create/patch from successful tasks)
 * - auto-work-flow: knowledge.tool + pm-memory + deep-research eval loop
 */

import type {
  AgentEvent,
  AgentInput,
  AgentLogger,
  LLMProvider,
  LLMUsage,
} from '@nexora/contracts';

// ─── Types ─────────────────────────────────────────────────────────────

export interface ExecutionRecord {
  /** Agent that ran */
  agentName: string;
  /** What was asked */
  input: string;
  /** What happened */
  events: AgentEvent[];
  /** Final content (empty if failed) */
  result: string;
  /** Did it succeed? */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Token usage */
  usage?: LLMUsage;
  /** Duration in ms */
  durationMs: number;
  /** Timestamp */
  timestamp: number;
  /** Was handraise used? */
  usedHandraise: boolean;
  /** Tools that were called */
  toolsCalled: string[];
}

export interface LearningOutcome {
  type: 'skill-created' | 'skill-patched' | 'knowledge-saved' | 'no-action';
  /** What was learned */
  description: string;
  /** Skill or knowledge name (if created/saved) */
  name?: string;
}

export interface PerformanceSnapshot {
  /** Time window start */
  since: number;
  /** Total executions */
  total: number;
  /** Successful executions */
  succeeded: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Average duration */
  avgDurationMs: number;
  /** Total cost */
  totalCostUsd: number;
  /** Most common failure patterns */
  failurePatterns: Array<{ pattern: string; count: number }>;
  /** Most used tools */
  topTools: Array<{ name: string; count: number }>;
}

// ─── Execution Tracker ─────────────────────────────────────────────────

/**
 * Tracks execution results and extracts learning signals.
 * Call recordExecution() after every agent run.
 */
export class ExecutionTracker {
  private records: ExecutionRecord[] = [];
  private readonly maxRecords: number;

  constructor(options?: { maxRecords?: number }) {
    this.maxRecords = options?.maxRecords ?? 1000;
  }

  record(record: ExecutionRecord): void {
    this.records.push(record);
    // Evict old records
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }

  /** Build execution record from agent events */
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
    const usedHandraise = toolCalls.includes('handraise');

    return {
      agentName,
      input: input.prompt,
      events,
      result: doneEvent?.type === 'done' ? doneEvent.content : '',
      success: !!doneEvent && !errorEvent,
      error: errorEvent?.type === 'error' ? errorEvent.message : undefined,
      durationMs,
      timestamp: Date.now(),
      usedHandraise,
      toolsCalled: [...new Set(toolCalls)],
    };
  }

  /** Get performance snapshot for a time window */
  getSnapshot(sinceMs?: number): PerformanceSnapshot {
    const since = sinceMs ?? Date.now() - 24 * 60 * 60 * 1000; // default: last 24h
    const recent = this.records.filter(r => r.timestamp >= since);

    const succeeded = recent.filter(r => r.success).length;
    const avgDuration = recent.length > 0
      ? recent.reduce((s, r) => s + r.durationMs, 0) / recent.length
      : 0;
    const totalCost = recent.reduce((s, r) => {
      if (!r.usage) return s;
      // Rough cost estimate: $3/M input, $15/M output (Claude Sonnet pricing)
      return s + (r.usage.promptTokens * 3 + r.usage.completionTokens * 15) / 1_000_000;
    }, 0);

    // Failure pattern extraction
    const failureCounts = new Map<string, number>();
    for (const r of recent.filter(r => !r.success)) {
      const pattern = categorizeFailure(r);
      failureCounts.set(pattern, (failureCounts.get(pattern) ?? 0) + 1);
    }

    // Tool usage
    const toolCounts = new Map<string, number>();
    for (const r of recent) {
      for (const tool of r.toolsCalled) {
        toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
      }
    }

    return {
      since,
      total: recent.length,
      succeeded,
      successRate: recent.length > 0 ? succeeded / recent.length : 0,
      avgDurationMs: avgDuration,
      totalCostUsd: totalCost,
      failurePatterns: [...failureCounts.entries()]
        .map(([pattern, count]) => ({ pattern, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      topTools: [...toolCounts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
    };
  }

  getRecords(): readonly ExecutionRecord[] {
    return this.records;
  }

  getRecentFailures(limit = 10): ExecutionRecord[] {
    return this.records.filter(r => !r.success).slice(-limit);
  }
}

// ─── Learning Engine ───────────────────────────────────────────────────

export interface LearningEngineOptions {
  /** LLM for analyzing failures and generating skills */
  llm: LLMProvider;
  /** Skill creation callback (integrate with SkillCreator) */
  onSkillCreate?: (name: string, content: string) => Promise<void>;
  /** Knowledge save callback (integrate with KnowledgeStore) */
  onKnowledgeSave?: (topic: string, content: string) => Promise<void>;
  /** Minimum tool calls for a task to be "complex enough" to learn from */
  minToolCallsForSkill?: number;
  /** Logger */
  logger?: AgentLogger;
}

/**
 * Analyzes execution records and generates learning outcomes.
 *
 * Learning triggers:
 * - Complex task succeeded (5+ tool calls) → extract as skill
 * - Task failed with diagnosable pattern → save prevention skill
 * - Handraise was used and answered → save answer as knowledge
 * - Same failure pattern repeated 3+ times → escalate
 */
export class LearningEngine {
  private readonly llm: LLMProvider;
  private readonly onSkillCreate: LearningEngineOptions['onSkillCreate'];
  private readonly onKnowledgeSave: LearningEngineOptions['onKnowledgeSave'];
  private readonly minToolCalls: number;
  private readonly logger: AgentLogger;

  constructor(options: LearningEngineOptions) {
    this.llm = options.llm;
    this.onSkillCreate = options.onSkillCreate;
    this.onKnowledgeSave = options.onKnowledgeSave;
    this.minToolCalls = options.minToolCallsForSkill ?? 5;
    this.logger = options.logger ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  }

  /**
   * Analyze a single execution and decide whether to learn from it.
   */
  async analyze(record: ExecutionRecord): Promise<LearningOutcome> {
    // Successful complex task → extract as skill
    if (record.success && record.toolsCalled.length >= this.minToolCalls) {
      return this.learnFromSuccess(record);
    }

    // Failed task → analyze and save prevention
    if (!record.success && record.error) {
      return this.learnFromFailure(record);
    }

    // Handraise used → save the interaction as knowledge
    if (record.usedHandraise && record.success) {
      return this.learnFromHandraise(record);
    }

    return { type: 'no-action', description: 'No learning signal' };
  }

  /**
   * Periodic reflection — analyze recent performance and suggest improvements.
   */
  async reflect(snapshot: PerformanceSnapshot): Promise<string> {
    if (snapshot.total < 5) return 'Not enough data for reflection.';

    const prompt = `You are analyzing an AI agent team's recent performance.

Performance data:
- Total executions: ${snapshot.total}
- Success rate: ${(snapshot.successRate * 100).toFixed(1)}%
- Avg duration: ${(snapshot.avgDurationMs / 1000).toFixed(1)}s
- Total cost: $${snapshot.totalCostUsd.toFixed(4)}

Top failure patterns:
${snapshot.failurePatterns.map(f => `- ${f.pattern} (${f.count}x)`).join('\n')}

Top tools used:
${snapshot.topTools.map(t => `- ${t.name} (${t.count}x)`).join('\n')}

Based on this data, provide:
1. The single most impactful improvement to make
2. Any failure patterns that suggest a missing skill or tool
3. Whether the cost/performance ratio is reasonable

Be concise (under 200 words). Focus on actionable recommendations.`;

    const response = await this.llm.complete([{ role: 'user', content: prompt }], {
      maxTokens: 500,
    });
    return response.content;
  }

  private async learnFromSuccess(record: ExecutionRecord): Promise<LearningOutcome> {
    if (!this.onSkillCreate) {
      return { type: 'no-action', description: 'Skill creation callback not configured' };
    }

    const toolSequence = record.toolsCalled.join(' → ');
    const prompt = `An AI agent successfully completed this task:

Task: ${record.input.slice(0, 500)}
Tools used: ${toolSequence}
Result: ${record.result.slice(0, 500)}

Extract the reusable approach as a SKILL.md file. Include:
1. A clear skill name (kebab-case)
2. Steps the agent took
3. Which tools were used and why
4. Any patterns that would help with similar future tasks

Output ONLY the SKILL.md content (with --- frontmatter).`;

    try {
      const response = await this.llm.complete([{ role: 'user', content: prompt }], {
        maxTokens: 1000,
      });

      const nameMatch = response.content.match(/name:\s*(.+)/);
      const name = nameMatch?.[1]?.trim() ?? `auto-${Date.now()}`;

      await this.onSkillCreate(name, response.content);
      this.logger.info(`Skill created from successful task: ${name}`);

      return {
        type: 'skill-created',
        description: `Extracted skill "${name}" from successful ${record.toolsCalled.length}-tool task`,
        name,
      };
    } catch (err) {
      this.logger.warn(`Failed to create skill from success: ${err}`);
      return { type: 'no-action', description: 'Skill extraction failed' };
    }
  }

  private async learnFromFailure(record: ExecutionRecord): Promise<LearningOutcome> {
    if (!this.onSkillCreate) {
      return { type: 'no-action', description: 'Skill creation callback not configured' };
    }

    const prompt = `An AI agent FAILED this task:

Task: ${record.input.slice(0, 500)}
Error: ${record.error}
Tools attempted: ${record.toolsCalled.join(', ')}

Analyze the failure and create a prevention skill. Include:
1. What went wrong (root cause)
2. How to avoid this in the future
3. The correct approach for this type of task

Output ONLY the SKILL.md content (with --- frontmatter).
Name it with a "prevent-" prefix.`;

    try {
      const response = await this.llm.complete([{ role: 'user', content: prompt }], {
        maxTokens: 1000,
      });

      const nameMatch = response.content.match(/name:\s*(.+)/);
      const name = nameMatch?.[1]?.trim() ?? `prevent-${Date.now()}`;

      await this.onSkillCreate(name, response.content);
      this.logger.info(`Prevention skill created from failure: ${name}`);

      return {
        type: 'skill-created',
        description: `Created prevention skill "${name}" from failure: ${record.error?.slice(0, 100)}`,
        name,
      };
    } catch (err) {
      this.logger.warn(`Failed to create skill from failure: ${err}`);
      return { type: 'no-action', description: 'Failure skill extraction failed' };
    }
  }

  private async learnFromHandraise(record: ExecutionRecord): Promise<LearningOutcome> {
    if (!this.onKnowledgeSave) {
      return { type: 'no-action', description: 'Knowledge save callback not configured' };
    }

    // The handraise answer is in the result
    const topic = `handraise-${record.agentName}-${Date.now()}`;
    const content = `# Learned from handraise\n\n**Question context:** ${record.input.slice(0, 300)}\n\n**Answer:** ${record.result.slice(0, 1000)}`;

    try {
      await this.onKnowledgeSave(topic, content);
      this.logger.info(`Knowledge saved from handraise: ${topic}`);

      return {
        type: 'knowledge-saved',
        description: `Saved handraise answer as knowledge: ${topic}`,
        name: topic,
      };
    } catch (err) {
      this.logger.warn(`Failed to save handraise knowledge: ${err}`);
      return { type: 'no-action', description: 'Knowledge save failed' };
    }
  }
}

// ─── Improvement Loop ──────────────────────────────────────────────────

export interface ImprovementLoopOptions {
  /** Execution tracker to analyze */
  tracker: ExecutionTracker;
  /** Learning engine for generating skills/knowledge */
  learner: LearningEngine;
  /** Logger */
  logger?: AgentLogger;
  /** Auto-learn after every execution? Default: true */
  autoLearn?: boolean;
  /** Reflection interval in ms. Default: 24h. Set 0 to disable. */
  reflectionIntervalMs?: number;
}

/**
 * Wires together tracking + learning into a continuous improvement loop.
 *
 * Usage:
 * ```typescript
 * const loop = createImprovementLoop({
 *   tracker: new ExecutionTracker(),
 *   learner: new LearningEngine({ llm, onSkillCreate: ... }),
 * });
 *
 * // After each agent run:
 * const record = ExecutionTracker.fromEvents(agentName, input, events, duration);
 * await loop.recordAndLearn(record);
 *
 * // Periodic reflection (or call manually):
 * const insights = await loop.reflect();
 * ```
 */
export function createImprovementLoop(options: ImprovementLoopOptions) {
  const { tracker, learner } = options;
  const autoLearn = options.autoLearn ?? true;
  const logger = options.logger ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  let reflectionTimer: ReturnType<typeof setInterval> | null = null;
  const reflectionInterval = options.reflectionIntervalMs ?? 24 * 60 * 60 * 1000;

  if (reflectionInterval > 0) {
    reflectionTimer = setInterval(async () => {
      try {
        const snapshot = tracker.getSnapshot();
        const insights = await learner.reflect(snapshot);
        logger.info('Self-improvement reflection', { insights });
      } catch {
        // Reflection failure is non-critical
      }
    }, reflectionInterval);
  }

  return {
    /** Record execution and optionally learn from it */
    async recordAndLearn(record: ExecutionRecord): Promise<LearningOutcome> {
      tracker.record(record);
      if (autoLearn) {
        return learner.analyze(record);
      }
      return { type: 'no-action', description: 'Auto-learn disabled' };
    },

    /** Manual reflection trigger */
    async reflect(): Promise<string> {
      const snapshot = tracker.getSnapshot();
      return learner.reflect(snapshot);
    },

    /** Get current performance snapshot */
    getSnapshot(sinceMs?: number): PerformanceSnapshot {
      return tracker.getSnapshot(sinceMs);
    },

    /** Stop the reflection timer */
    stop(): void {
      if (reflectionTimer) {
        clearInterval(reflectionTimer);
        reflectionTimer = null;
      }
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
