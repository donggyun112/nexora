import { describe, it, expect } from 'vitest';
import { ToolsetRegistry } from '../registry.js';

describe('ToolsetRegistry', () => {
  it('resolves a simple toolset', () => {
    const reg = new ToolsetRegistry();
    reg.register('base', { tools: ['read', 'grep'] });
    expect(reg.resolve('base')).toEqual(['read', 'grep']);
  });

  it('resolves includes recursively', () => {
    const reg = new ToolsetRegistry();
    reg.register('base', { tools: ['read', 'grep'] });
    reg.register('dev', { tools: ['exec', 'edit'], includes: ['base'] });
    reg.register('full', { tools: ['web-search'], includes: ['dev'] });

    const result = reg.resolve('full');
    expect(result).toEqual(['read', 'grep', 'exec', 'edit', 'web-search']);
  });

  it('deduplicates tools across includes', () => {
    const reg = new ToolsetRegistry();
    reg.register('a', { tools: ['read', 'grep'] });
    reg.register('b', { tools: ['read', 'exec'] });
    reg.register('c', { tools: [], includes: ['a', 'b'] });

    const result = reg.resolve('c');
    expect(result).toEqual(['read', 'grep', 'exec']);
  });

  it('detects cycles without infinite loop', () => {
    const reg = new ToolsetRegistry();
    reg.register('a', { tools: ['read'], includes: ['b'] });
    reg.register('b', { tools: ['grep'], includes: ['a'] });

    const result = reg.resolve('a');
    expect(result).toContain('read');
    expect(result).toContain('grep');
  });

  it('returns empty for unknown toolset', () => {
    const reg = new ToolsetRegistry();
    expect(reg.resolve('nonexistent')).toEqual([]);
  });

  it('lists registered toolset names', () => {
    const reg = new ToolsetRegistry();
    reg.register('base', { tools: ['read'] });
    reg.register('dev', { tools: ['exec'] });
    expect(reg.list().sort()).toEqual(['base', 'dev']);
  });
});
