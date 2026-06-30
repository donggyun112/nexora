/**
 * Stdio MCP bridge — spawn a stdio MCP server and expose its tools as Nexora
 * ToolDefinition objects through the generic mcpClientToTools bridge.
 */
import type { IOType } from 'node:child_process';
import type { Stream } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolDefinition } from '@dongkseo/contracts';
import { mcpClientToTools, type McpClientBridgeOptions } from './client.js';
import type { McpCallResult, McpClientLike, McpToolDescriptor } from './types.js';

export interface StdioMcpBridgeOptions {
  /** Client name sent during MCP initialize. */
  name: string;
  /** Client version sent during MCP initialize. */
  version?: string;
  /** Server executable. */
  command: string;
  /** Server executable args. */
  args?: string[];
  /** Server process cwd. */
  cwd?: string;
  /** Extra env for the server process. Undefined values are omitted. */
  env?: Record<string, string | undefined>;
  /** Include MCP SDK's safe default inherited env. Default true. */
  inheritDefaultEnv?: boolean;
  /** Child stderr handling. Default "pipe" so boot errors can include details. */
  stderr?: IOType | Stream | number;
  /** Generic MCP client → ToolDefinition bridge options. */
  bridgeOptions?: McpClientBridgeOptions;
}

function normalizedEnv(options: StdioMcpBridgeOptions): Record<string, string> {
  const env = options.inheritDefaultEnv === false ? {} : getDefaultEnvironment();
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function normalizeTools(tools: Awaited<ReturnType<Client['listTools']>>['tools']): McpToolDescriptor[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));
}

async function withStdioClient<T>(
  options: StdioMcpBridgeOptions,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(
    { name: options.name, version: options.version ?? '0.1.0' },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args ?? [],
    cwd: options.cwd,
    env: normalizedEnv(options),
    stderr: options.stderr ?? 'pipe',
  });
  const stderrChunks: string[] = [];
  transport.stderr?.on('data', (chunk) => {
    stderrChunks.push(String(chunk));
  });

  try {
    await client.connect(transport);
    return await fn(client);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = stderrChunks.join('').trim();
    throw new Error(stderr ? `${msg}\n${stderr}` : msg);
  } finally {
    try {
      await client.close();
    } catch {
      // Ignore close errors after failed stdio sessions.
    }
  }
}

function sdkResultToMcpResult(result: Awaited<ReturnType<Client['callTool']>>): McpCallResult {
  if ('toolResult' in result) {
    return {
      content: [],
      toolResult: result.toolResult,
    };
  }
  return {
    content: result.content,
    isError: result.isError,
    structuredContent: result.structuredContent,
  };
}

/**
 * Create ToolDefinitions for a stdio MCP server. The server is opened once to
 * discover tool schemas, then opened per tool call. This keeps server lifecycle
 * self-contained and avoids leaking child processes into app runtimes.
 */
export async function createStdioMcpBridgeTools(
  options: StdioMcpBridgeOptions,
): Promise<ToolDefinition[]> {
  const adapter: McpClientLike = {
    async listTools() {
      const tools = await withStdioClient(options, async (client) => {
        const list = await client.listTools();
        return normalizeTools(list.tools);
      });
      return { tools };
    },
    async callTool(args) {
      return withStdioClient(options, async (client) => {
        const result = await client.callTool({
          name: args.name,
          arguments: args.arguments,
        });
        return sdkResultToMcpResult(result);
      });
    },
  };

  return mcpClientToTools(adapter, options.bridgeOptions);
}
