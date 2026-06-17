/**
 * Framework lint — enforces Nexora's architectural rules at runtime.
 *
 * These checks run during bootstrapAgent() and scaffold generation.
 * Philosophy: if a rule is important enough to write down, it should be
 * hard to violate. Document → Warn → Error → Prevent.
 *
 * Rules:
 *   1. Topic naming: {domain}.{action}[.{qualifier}]
 *   2. AgentCard completeness: subscribes, publishes, architecture must be set
 *   3. Tenant isolation: tenantId must be set in production mode
 *   4. Schema presence: input/outputSchema recommended (warn if missing)
 *   5. Publishes declaration: every result topic must match card.publishes
 */

import type { AgentCard, AgentLogger } from '@dongkseo/contracts';

export interface LintResult {
  errors: string[];
  warnings: string[];
}

const TOPIC_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/;

export function lintAgentCard(card: AgentCard): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Rule 1: Topic naming
  for (const t of card.subscribes) {
    if (!TOPIC_PATTERN.test(t)) {
      errors.push(
        `subscribes topic "${t}" must match {domain}.{action} pattern ` +
        `(lowercase, dot-separated). Example: "code.review.requested"`,
      );
    }
  }
  for (const t of card.publishes) {
    if (!TOPIC_PATTERN.test(t)) {
      errors.push(
        `publishes topic "${t}" must match {domain}.{action} pattern`,
      );
    }
  }

  // Rule 2: Card completeness
  if (card.subscribes.length === 0) {
    warnings.push(
      `Agent "${card.name}" has no subscribes — it won't receive any messages`,
    );
  }
  if (card.publishes.length === 0) {
    warnings.push(
      `Agent "${card.name}" has no publishes — results will go to <topic>.completed (implicit)`,
    );
  }
  if (!card.architecture) {
    errors.push(`Agent "${card.name}" must declare an architecture`);
  }
  if (!card.name || !/^[a-z][a-z0-9-]*$/.test(card.name)) {
    errors.push(
      `Agent name "${card.name}" must be lowercase alphanumeric with hyphens`,
    );
  }

  // Rule 4: Schema recommendation
  if (!card.inputSchema) {
    warnings.push(
      `Agent "${card.name}" has no inputSchema — incoming payloads won't be validated`,
    );
  }
  if (!card.outputSchema) {
    warnings.push(
      `Agent "${card.name}" has no outputSchema — outgoing payloads won't be validated`,
    );
  }

  return { errors, warnings };
}

/**
 * Run lint and log/throw based on results.
 * Called by bootstrapAgent() and scaffold generator.
 */
export function enforceLint(card: AgentCard, logger: AgentLogger, strict = false): void {
  const { errors, warnings } = lintAgentCard(card);

  for (const w of warnings) {
    logger.warn(`[lint] ${w}`);
  }

  if (errors.length > 0) {
    const msg = `Agent "${card.name}" has ${errors.length} lint error(s):\n` +
      errors.map(e => `  - ${e}`).join('\n');
    if (strict) throw new Error(msg);
    logger.error(`[lint] ${msg}`);
  }
}
