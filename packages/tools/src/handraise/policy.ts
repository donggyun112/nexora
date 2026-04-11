/**
 * HandraisePolicy — rule-based auto-answer for handraise requests.
 *
 * The premise: most handraise requests are predictable. "Delete files older
 * than 30 days in /tmp?" is almost always safe; "Approve a $10 refund?" is
 * almost always approved; "Which auth provider for this login?" is always
 * the primary one. Routing every question to a human is exhausting for the
 * human AND slow for the agent.
 *
 * A policy lives BETWEEN the agent's handraise and the eventual recipient.
 * It sees the question + context and can answer immediately if it matches
 * a rule. Unmatched requests fall through to the configured recipient
 * (human, other agent, etc).
 *
 * Rules are user-provided functions, not regex — we don't want a DSL.
 * Each rule returns either a matched answer or skip, and the first match wins.
 */

import type { HandraiseRecipient } from '../builtin/handraise.js';

export interface HandraiseContext {
  question: string;
  context?: unknown;
  recipient: HandraiseRecipient;
  tenantId: string;
}

export interface HandraiseRule {
  /** Human-readable identifier for logging. */
  id: string;
  /**
   * Predicate + answer in one function. Returns `null` to skip the rule
   * (caller tries the next one), or a HandraiseRuleMatch to answer.
   */
  evaluate(ctx: HandraiseContext): Promise<HandraiseRuleMatch | null> | HandraiseRuleMatch | null;
}

export interface HandraiseRuleMatch {
  answer: unknown;
  /** Optional human-readable reasoning attached to the answer. */
  rationale?: string;
}

export interface HandraisePolicyResult {
  matched: boolean;
  answer?: unknown;
  rationale?: string;
  /** The id of the rule that matched, for auditing. */
  rule?: string;
}

export class HandraisePolicy {
  constructor(private readonly rules: HandraiseRule[]) {}

  async evaluate(ctx: HandraiseContext): Promise<HandraisePolicyResult> {
    for (const rule of this.rules) {
      const result = await rule.evaluate(ctx);
      if (result !== null) {
        return {
          matched: true,
          answer: result.answer,
          rationale: result.rationale,
          rule: rule.id,
        };
      }
    }
    return { matched: false };
  }

  /** Add a rule at runtime. Rules added later run LAST. */
  addRule(rule: HandraiseRule): void {
    this.rules.push(rule);
  }
}

/**
 * Shorthand for a common policy shape: "approve everything about topic X".
 * Often used for auto-approval of safe categories like tmp cleanup or
 * low-amount refunds.
 */
export function approveMatching(
  id: string,
  predicate: (ctx: HandraiseContext) => boolean,
  answer: unknown = { approved: true },
  rationale?: string,
): HandraiseRule {
  return {
    id,
    evaluate: (ctx) => (predicate(ctx) ? { answer, rationale } : null),
  };
}

/**
 * Shorthand for "deny matching" — auto-reject a pattern before it reaches a human.
 * Useful to enforce explicit deny-lists (e.g. never auto-approve payments > $1000).
 */
export function denyMatching(
  id: string,
  predicate: (ctx: HandraiseContext) => boolean,
  reason: string,
): HandraiseRule {
  return {
    id,
    evaluate: (ctx) =>
      predicate(ctx)
        ? { answer: { approved: false, reason }, rationale: reason }
        : null,
  };
}
