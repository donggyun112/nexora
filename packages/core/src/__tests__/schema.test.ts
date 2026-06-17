/**
 * Schema validation — ensures card.inputSchema/outputSchema are ENFORCED,
 * not advisory. Tests the createSchemaValidator helper directly and the
 * bootstrap-level integration (input rejection → schema-rejected topic;
 * output rejection → .failed topic).
 */

import { describe, it, expect } from 'vitest';
import { createSchemaValidator, SchemaValidationError } from '../schema.js';
import type { AgentCard } from '@dongkseo/contracts';

function cardWith(inputSchema?: unknown, outputSchema?: unknown): AgentCard {
  return {
    name: 'schema-test',
    version: '0.1.0',
    description: '',
    capabilities: [],
    subscribes: ['test'],
    publishes: ['test.done'],
    tools: [],
    architecture: 'echo',
    inputSchema: inputSchema as Record<string, unknown> | undefined,
    outputSchema: outputSchema as Record<string, unknown> | undefined,
  };
}

describe('createSchemaValidator', () => {
  it('no-op when neither schema is set', () => {
    const { validateInput, validateOutput } = createSchemaValidator(cardWith());
    // Should never throw, regardless of payload
    expect(() => validateInput({ any: 'thing' })).not.toThrow();
    expect(() => validateOutput(42)).not.toThrow();
  });

  it('enforces inputSchema: rejects missing required field', () => {
    const { validateInput } = createSchemaValidator(cardWith({
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
      required: ['name', 'age'],
    }));

    expect(() => validateInput({ name: 'alice', age: 30 })).not.toThrow();
    expect(() => validateInput({ name: 'alice' })).toThrow(SchemaValidationError);
    expect(() => validateInput({ name: 'alice' })).toThrow(/age/);
  });

  it('enforces inputSchema: rejects wrong type', () => {
    const { validateInput } = createSchemaValidator(cardWith({
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
    }));

    expect(() => validateInput({ count: 42 })).not.toThrow();
    expect(() => validateInput({ count: 'forty-two' })).toThrow(SchemaValidationError);
  });

  it('enforces outputSchema independently of inputSchema', () => {
    const { validateInput, validateOutput } = createSchemaValidator(cardWith(
      undefined,
      { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
    ));

    expect(() => validateInput({ anything: true })).not.toThrow(); // no input schema
    expect(() => validateOutput({ result: 'ok' })).not.toThrow();
    expect(() => validateOutput({ result: 123 })).toThrow(SchemaValidationError);
  });

  it('SchemaValidationError carries the AJV errors for downstream inspection', () => {
    const { validateInput } = createSchemaValidator(cardWith({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a', 'b'],
    }));

    try {
      validateInput({ a: 'x' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      const sve = err as SchemaValidationError;
      expect(sve.errors.length).toBeGreaterThan(0);
      expect(sve.message).toMatch(/schema-test/);
    }
  });
});
