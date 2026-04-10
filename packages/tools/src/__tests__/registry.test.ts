import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolDefinition, ToolResult } from '@nexora/contracts';

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
});
