import { describe, expect, it } from 'vitest';
import { sandboxToolDefinitions, registerSandboxTools } from '../builtin/sandbox-bundle.js';
import { ToolRegistry } from '../registry.js';

describe('sandboxToolDefinitions', () => {
  it('returns the five sandbox-aware builtin tools', () => {
    const names = sandboxToolDefinitions().map(t => t.name).sort();
    expect(names).toEqual(['edit', 'exec', 'grep', 'read', 'write']);
  });

  it('accepts exec options without throwing', () => {
    const defs = sandboxToolDefinitions({ exec: { allowList: ['python3'], defaultTimeoutMs: 60_000 } });
    expect(defs.find(t => t.name === 'exec')).toBeDefined();
  });
});

describe('registerSandboxTools', () => {
  it('registers all five tools into a registry', () => {
    const registry = new ToolRegistry();
    registerSandboxTools(registry);
    // assemble({}) has no availability gating for fs/exec tools, so it returns all registered tools
    const assembled = registry.assemble({}).map(t => t.name).sort();
    for (const name of ['edit', 'exec', 'grep', 'read', 'write']) {
      expect(assembled).toContain(name);
    }
  });
});
