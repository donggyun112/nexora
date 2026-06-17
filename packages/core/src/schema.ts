/**
 * Schema validation for message boundaries.
 *
 * Nexora's AgentCard already carries `inputSchema` and `outputSchema` fields
 * as JSON Schema. Until now those fields were advisory — payloads were
 * cast at runtime with no enforcement. That meant a drift between a card's
 * declared schema and the actual payload shape would silently corrupt the
 * pipeline.
 *
 * This module plugs AJV in so bootstrap can reject malformed messages at
 * both ends:
 *   - On the subscribe side: incoming envelope payloads are validated
 *     against `card.inputSchema` BEFORE the agent sees them.
 *   - On the publish side: outgoing result payloads are validated against
 *     `card.outputSchema` BEFORE they hit the transport.
 *
 * Schema validation is OFF by default (if either field is missing). Agents
 * that want enforcement explicitly add the JSON Schema to their card.
 */

import Ajv, { type ValidateFunction, type ErrorObject } from 'ajv';
import type { AgentCard } from '@dongkseo/contracts';

export class SchemaValidationError extends Error {
  readonly errors: ErrorObject[];
  constructor(side: 'input' | 'output', agent: string, errors: ErrorObject[]) {
    const summary = errors.slice(0, 3).map(e => `${e.instancePath || '/'} ${e.message}`).join('; ');
    super(`Schema validation failed for ${agent} ${side}: ${summary}`);
    this.name = 'SchemaValidationError';
    this.errors = errors;
  }
}

/**
 * Build an input/output validator pair from an AgentCard.
 * Returns no-op validators for any field the card doesn't specify.
 *
 * The AJV instance is cached per call — callers should build the validator
 * once at bootstrap, not per-request.
 */
export function createSchemaValidator(card: AgentCard): {
  validateInput: (payload: unknown) => void;
  validateOutput: (payload: unknown) => void;
} {
  const ajv = new Ajv({
    // Keep errors reasonable. strictSchema false because card schemas come
    // from users and may use relaxed JSON Schema drafts.
    allErrors: true,
    strictSchema: false,
    strictTypes: false,
    strictTuples: false,
  });

  const inputValidate: ValidateFunction | null = card.inputSchema
    ? ajv.compile(card.inputSchema)
    : null;
  const outputValidate: ValidateFunction | null = card.outputSchema
    ? ajv.compile(card.outputSchema)
    : null;

  return {
    validateInput(payload: unknown): void {
      if (!inputValidate) return;
      if (inputValidate(payload)) return;
      throw new SchemaValidationError('input', card.name, inputValidate.errors ?? []);
    },
    validateOutput(payload: unknown): void {
      if (!outputValidate) return;
      if (outputValidate(payload)) return;
      throw new SchemaValidationError('output', card.name, outputValidate.errors ?? []);
    },
  };
}
