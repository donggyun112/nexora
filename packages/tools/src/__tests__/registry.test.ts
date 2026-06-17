import { describe, it, expect } from 'vitest';
import { assembleToolsWithPolicy, resolveToolPolicy, ToolRegistry } from '../registry.js';
import type { ToolDefinition, ToolResult } from '@dongkseo/contracts';

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    execute: async (): Promise<ToolResult> => ({ type: 'text', text: name }),
  };
}

describe('ToolRegistry', () => {
  it('registers and retrieves tools', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('a'));
    reg.registerAll([makeTool('b'), makeTool('c')]);

    expect(reg.size()).toBe(3);
    expect(reg.has('a')).toBe(true);
    expect(reg.get('b')?.name).toBe('b');
    expect(reg.names().sort()).toEqual(['a', 'b', 'c']);
  });

  it('overwrites on re-register', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('a'));
    const newA: ToolDefinition = {
      name: 'a',
      description: 'updated',
      parameters: {},
      execute: async () => ({ type: 'text', text: 'new' }),
    };
    reg.register(newA);
    expect(reg.size()).toBe(1);
    expect(reg.get('a')?.description).toBe('updated');
  });

  it('unregister removes tools', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('a'));
    expect(reg.unregister('a')).toBe(true);
    expect(reg.unregister('missing')).toBe(false);
    expect(reg.size()).toBe(0);
  });

  it('assemble with allowed whitelist', () => {
    const reg = new ToolRegistry();
    reg.registerAll([makeTool('a'), makeTool('b'), makeTool('c')]);
    const result = reg.assemble({ allowed: ['a', 'c'] });
    expect(result.map(t => t.name).sort()).toEqual(['a', 'c']);
  });

  it('assemble with blocked blacklist', () => {
    const reg = new ToolRegistry();
    reg.registerAll([makeTool('a'), makeTool('b'), makeTool('c')]);
    const result = reg.assemble({ blocked: ['b'] });
    expect(result.map(t => t.name).sort()).toEqual(['a', 'c']);
  });

  it('assemble with pattern', () => {
    const reg = new ToolRegistry();
    reg.registerAll([makeTool('exec'), makeTool('read'), makeTool('grep')]);
    const result = reg.assemble({ pattern: /^(read|grep)$/ });
    expect(result.map(t => t.name).sort()).toEqual(['grep', 'read']);
  });

  it('assemble combines pattern + blocked + allowed', () => {
    const reg = new ToolRegistry();
    reg.registerAll([makeTool('a'), makeTool('b'), makeTool('c'), makeTool('d')]);
    const result = reg.assemble({
      pattern: /^[abc]$/,
      blocked: ['b'],
      allowed: ['a', 'b', 'c'],
    });
    expect(result.map(t => t.name).sort()).toEqual(['a', 'c']);
  });

  it('resolves layered policy through context, card, and adapter restrictions', () => {
    const policy = resolveToolPolicy({
      availableToolNames: ['write', 'read', 'exec', 'grep'],
      layers: [{ label: 'global', allow: ['group:fs', 'group:runtime'] }],
      contextTools: ['read', 'exec'],
      cardTools: ['read', 'grep'],
      adapter: { deny: ['grep'], label: 'http' },
    });

    expect(policy.allowedToolNames).toEqual(['read']);
    expect(policy.layers.map(layer => layer.label)).toEqual([
      'global',
      'context',
      'agent.card',
      'http',
    ]);
  });

  it('assembles tools with the shared policy path', () => {
    const reg = new ToolRegistry();
    reg.registerAll([makeTool('read'), makeTool('grep'), makeTool('exec')]);

    const result = assembleToolsWithPolicy(reg, {
      contextTools: ['read', 'exec'],
      cardTools: ['read', 'grep'],
    });

    expect(result.allowedToolNames).toEqual(['read']);
    expect(result.tools.map(tool => tool.name)).toEqual(['read']);
  });

  it('fails closed when policy layers resolve to no tools', () => {
    const reg = new ToolRegistry();
    reg.registerAll([makeTool('read'), makeTool('exec')]);

    const result = assembleToolsWithPolicy(reg, {
      contextTools: ['read'],
      cardTools: ['exec'],
    });

    expect(result.allowedToolNames).toEqual([]);
    expect(result.tools).toEqual([]);
  });
});
