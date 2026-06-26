// @ts-nocheck — uses dynamic imports for workspace packages that are NOT listed
// as deps of @dongkseo/cli (by design — the CLI is a thin orchestrator). They
// resolve at runtime inside the Nexora workspace. Same pattern as dev.ts.
/**
 * nexora test-serve — boot a real, deterministic, keyless Nexora service that a
 * coding assistant can drive over HTTP to verify the framework end-to-end.
 *
 * Full pipeline, no API key (built-in mock LLM):
 *   HTTP → HttpAdapter → GatewayRouter → Transport → bootstrap → AgentRunner
 *        → ReAct → Tools → response
 *
 * Every step is emitted as a structured JSONL line on stdout so the driver can
 * assert not just the final reply but that routing + tools actually ran:
 *   {"ts":...,"ev":"ready","port":3000,...}
 *   {"ts":...,"ev":"request","payload":{...}}
 *   {"ts":...,"ev":"log","level":"debug","msg":"tool.start read",...}
 *   {"ts":...,"ev":"response","payload":{...}}
 *
 * Usage (for a coding assistant):
 *   nexora test-serve --port 3000        # prints {"ev":"ready",...} when up
 *   curl -s localhost:3000/messages -d '{"content":"read the file"}'
 *   curl -s localhost:3000/messages -d '{"content":"hello"}'
 *   # Ctrl-C / SIGTERM to stop.
 *
 * Deterministic mock triggers: "read the file" → read tool, "search for"/"grep"
 * → grep tool, "hello" → greeting, anything else → echo.
 */

export interface TestServeOptions {
  port: number;
}

export async function runTestServe(options: TestServeOptions): Promise<void> {
  const { LocalTransport } = (await import('@dongkseo/transport' as string)) as typeof import('@dongkseo/transport');
  const { bootstrapAgent, AgentRunner, CoreToolExecutor } =
    (await import('@dongkseo/core' as string)) as typeof import('@dongkseo/core');
  const { createReactArchitecture } =
    (await import('@dongkseo/architectures' as string)) as typeof import('@dongkseo/architectures');
  const { createReadTool, createGrepTool } =
    (await import('@dongkseo/tools' as string)) as typeof import('@dongkseo/tools');
  const { HttpAdapter } = (await import('@dongkseo/adapters' as string)) as typeof import('@dongkseo/adapters');
  const { GatewayRouter } = (await import('@dongkseo/gateway' as string)) as typeof import('@dongkseo/gateway');
  const { defineAgent, topic } = (await import('@dongkseo/contracts' as string)) as typeof import('@dongkseo/contracts');
  const { SmartMockLLM } = await import('./mock-llm.js');

  // Structured JSONL events on stdout — the contract a driver parses.
  const emit = (event: Record<string, unknown>): void => {
    process.stdout.write(JSON.stringify({ ts: Date.now(), ...event }) + '\n');
  };
  const jsonl = {
    debug: (msg: string, data?: unknown) => emit({ ev: 'log', level: 'debug', msg, ...(data ? { data } : {}) }),
    info: (msg: string, data?: unknown) => emit({ ev: 'log', level: 'info', msg, ...(data ? { data } : {}) }),
    warn: (msg: string, data?: unknown) => emit({ ev: 'log', level: 'warn', msg, ...(data ? { data } : {}) }),
    error: (msg: string, data?: unknown) => emit({ ev: 'log', level: 'error', msg, ...(data ? { data } : {}) }),
  };

  const llm = new SmartMockLLM();
  const transport = new LocalTransport();

  const reqTopic = topic('test-agent.requested');
  const card = defineAgent({
    name: 'test-agent',
    version: '0.1.0',
    description: 'Deterministic mock agent for end-to-end testing (no API key).',
    architecture: 'react',
    tools: ['read', 'grep'],
    capabilities: ['general'],
    subscribes: [reqTopic],
    publishes: [topic('test-agent.completed')],
  });

  const contextLoader = {
    async load() {
      return {
        tenantId: 'test',
        systemPrompt: 'You are test-agent, a deterministic mock agent on the Nexora framework.',
        tools: ['read', 'grep'],
        limits: {},
        runtime: { workdir: process.cwd() },
      } as unknown as import('@dongkseo/contracts').AgentContext;
    },
  };

  const agent = await bootstrapAgent({
    card,
    contextLoader,
    transport,
    // Map an incoming envelope payload ({content} from the HTTP gateway, or
    // {prompt} from a self-wake) to the agent's input.
    toAgentInput: (env: { payload?: unknown }) => {
      const p = (env.payload ?? {}) as { content?: unknown; prompt?: unknown };
      const prompt =
        typeof p.prompt === 'string' ? p.prompt
          : typeof p.content === 'string' ? p.content
            : JSON.stringify(env.payload);
      return { prompt };
    },
    createRuntime: () =>
      new AgentRunner({
        architecture: createReactArchitecture({ systemPrompt: 'You are test-agent.' }),
        llm,
        logger: jsonl,
        tools: new CoreToolExecutor({
          tools: [createReadTool(), createGrepTool()],
          logger: jsonl,
          context: {
            tenantId: 'test',
            workdir: process.cwd(),
            secrets: { get: async () => undefined },
            logger: jsonl,
          },
        }),
      }),
  });

  // Observe request/response at the bus boundary (no router internals assumed).
  transport.subscribe(reqTopic, async (env) => emit({ ev: 'request', payload: env.payload }));
  transport.subscribe('test-agent.completed', async (env) => emit({ ev: 'response', payload: env.payload }));

  const router = new GatewayRouter({ transport, defaultTopic: reqTopic, timeoutMs: 15_000 });
  const http = new HttpAdapter({ port: options.port, host: '127.0.0.1', resolveTenant: () => 'test' });
  await http.start(router);

  emit({
    ev: 'ready',
    port: http.port(),
    url: `http://127.0.0.1:${http.port()}`,
    hint: 'POST /messages {"content":"read the file"} — triggers the read tool; "hello" greets; anything else echoes.',
  });

  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  emit({ ev: 'shutdown' });
  await http.stop();
  await agent.shutdown?.();
}
