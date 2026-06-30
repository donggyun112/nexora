import { describe, it, expect } from 'vitest';
import { mcpClientToTools, createMcpServerBridge } from '../mcp/index.js';
import type { McpClientLike } from '../mcp/types.js';
import type { ToolDefinition, ToolContext, ToolResult } from '@dongkseo/contracts';

function makeMockClient(): McpClientLike {
  return {
    listTools: async () => ({
      tools: [
        {
          name: 'add',
          description: 'Add two numbers',
          inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'echo',
          description: 'Echo input',
          inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
          annotations: { destructiveHint: true },
        },
      ],
    }),
    callTool: async ({ name, arguments: args }) => {
      if (name === 'add') {
        const { a, b } = args as { a: number; b: number };
        return { content: [{ type: 'text', text: String(a + b) }] };
      }
      if (name === 'echo') {
        return { content: [{ type: 'text', text: String((args as { msg: string }).msg) }] };
      }
      return { content: [{ type: 'text', text: 'unknown' }], isError: true };
    },
  };
}

describe('mcpClientToTools', () => {
  it('converts MCP tools to ToolDefinition[]', async () => {
    const client = makeMockClient();
    const tools = await mcpClientToTools(client);
    expect(tools).toHaveLength(2);
    expect(tools.map(t => t.name).sort()).toEqual(['add', 'echo']);
  });

  it('applies prefix', async () => {
    const tools = await mcpClientToTools(makeMockClient(), { prefix: 'mcp_' });
    expect(tools.map(t => t.name).sort()).toEqual(['mcp_add', 'mcp_echo']);
  });

  it('respects allowed/blocked filters', async () => {
    const allowed = await mcpClientToTools(makeMockClient(), { allowed: ['add'] });
    expect(allowed).toHaveLength(1);
    expect(allowed[0].name).toBe('add');

    const blocked = await mcpClientToTools(makeMockClient(), { blocked: ['echo'] });
    expect(blocked).toHaveLength(1);
    expect(blocked[0].name).toBe('add');
  });

  it('execute() forwards to MCP and unwraps text', async () => {
    const tools = await mcpClientToTools(makeMockClient());
    const addTool = tools.find(t => t.name === 'add')!;
    const ctx: ToolContext = {
      tenantId: 't',
      workdir: '/tmp',
      secrets: { get: async () => undefined },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };
    const result = await addTool.execute('1', { a: 2, b: 3 }, ctx);
    if (result.type === 'text') expect(result.text).toBe('5');
  });

  it('maps MCP annotations to ToolDefinition flags', async () => {
    const tools = await mcpClientToTools(makeMockClient(), { maxResultSizeChars: 1234 });
    const add = tools.find(t => t.name === 'add')!;
    const echo = tools.find(t => t.name === 'echo')!;

    expect(add.isReadOnly).toBe(true);
    expect(add.isConcurrencySafe).toBe(true);
    expect(add.maxResultSizeChars).toBe(1234);
    expect(echo.isDestructive).toBe(true);
  });
});

describe('createMcpServerBridge', () => {
  it('exposes ToolDefinitions as MCP handlers', async () => {
    const tool: ToolDefinition = {
      name: 'greet',
      description: 'Say hi',
      parameters: { type: 'object', properties: { name: { type: 'string' } } },
      execute: async (_id, input): Promise<ToolResult> => ({
        type: 'text',
        text: `hi ${(input as { name: string }).name}`,
      }),
    };
    const ctx: ToolContext = {
      tenantId: 't',
      workdir: '/tmp',
      secrets: { get: async () => undefined },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };

    const bridge = createMcpServerBridge([tool], ctx);

    const list = bridge.listToolsHandler();
    expect(list.tools).toHaveLength(1);
    expect(list.tools[0]).toEqual({
      name: 'greet',
      description: 'Say hi',
      inputSchema: tool.parameters,
    });

    const call = await bridge.callToolHandler({ name: 'greet', arguments: { name: 'world' } });
    expect(call.content[0]).toMatchObject({ type: 'text', text: 'hi world' });
    expect(call.isError).toBeUndefined();
  });

  it('returns error for unknown tool', async () => {
    const ctx: ToolContext = {
      tenantId: 't',
      workdir: '/tmp',
      secrets: { get: async () => undefined },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };
    const bridge = createMcpServerBridge([], ctx);
    const result = await bridge.callToolHandler({ name: 'missing', arguments: {} });
    expect(result.isError).toBe(true);
  });
});
