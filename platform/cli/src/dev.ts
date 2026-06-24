// @ts-nocheck — this file uses dynamic imports for workspace packages that
// are NOT listed as dependencies of @dongkseo/cli (by design — the CLI is a
// thin orchestrator, not a consumer of every Nexora package). TypeScript
// can't resolve these at compile time, but they resolve fine at runtime
// because the CLI runs inside the Nexora workspace where all packages are
// symlinked.
/**
 * nexora dev — start all agents + gateway + transport in one command.
 *
 * Scans the workspace for agent configs (agents/* /agent.config.ts),
 * boots a transport + an AgentRegistry, a CoreContextLoader, an HttpAdapter +
 * GatewayRouter, and bootstraps every discovered agent on the shared transport.
 *
 * This is the "golden path" dev experience:
 *   nexora create agent my-agent
 *   nexora dev
 *   curl http://localhost:3000/messages -d '{"content": "hello"}'
 *
 * Options:
 *   --port <n>     HTTP port (default 3000)
 *   --context <dir> Context root (default ./context)
 *   --agents <dir>  Agent directory (default ./agents)
 *   --model <name>  Default LLM model (default claude-sonnet-4-5)
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface DevOptions {
  port: number;
  contextDir: string;
  agentsDir: string;
  model: string;
}

export async function runDev(options: DevOptions): Promise<void> {
  // Dynamic imports so the CLI package stays dependency-free at build time.
  // At runtime, these resolve from the workspace's node_modules.
  const { createTransport } = await import('@dongkseo/transport' as string) as typeof import('@dongkseo/transport');
  const { createAgentRegistry } = await import('@dongkseo/registry' as string) as typeof import('@dongkseo/registry');
  const { CoreContextLoader } = await import('@dongkseo/context' as string) as typeof import('@dongkseo/context');
  const {
    AgentRunner,
    CoreToolExecutor,
    bootstrapAgent,
    PiAiProvider,
  } = await import('@dongkseo/core' as string) as typeof import('@dongkseo/core');
  const { createReactArchitecture } = await import('@dongkseo/architectures' as string) as typeof import('@dongkseo/architectures');
  const { createReadTool, createGrepTool, createWriteTool, createEditTool } = await import('@dongkseo/tools' as string) as typeof import('@dongkseo/tools');
  const { HttpAdapter } = await import('@dongkseo/adapters' as string) as typeof import('@dongkseo/adapters');
  const { GatewayRouter } = await import('@dongkseo/gateway' as string) as typeof import('@dongkseo/gateway');
  const { topic } = await import('@dongkseo/contracts' as string) as typeof import('@dongkseo/contracts');

  // ── Discover agents ────────────────────────────────────────────────────
  const agentsDir = path.resolve(options.agentsDir);
  if (!fs.existsSync(agentsDir)) {
    console.error(`No agents directory at ${agentsDir}. Run 'nexora create agent <name>' first.`);
    process.exit(1);
  }

  const agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .filter(d => fs.existsSync(path.join(agentsDir, d.name, 'agent.config.ts')) ||
                 fs.existsSync(path.join(agentsDir, d.name, 'dist', 'agent.config.js')));

  if (agentDirs.length === 0) {
    console.error(`No agents found in ${agentsDir}. Run 'nexora create agent <name>' first.`);
    process.exit(1);
  }

  // ── Infrastructure ─────────────────────────────────────────────────────
  // 엔트리포인트 책임: env를 읽어 transport config로 매핑한다(프레임워크는
  // env를 모른다 — 명시적 config만 받는다). 기본은 local. 멀티 프로세스/서버
  // 배포는 NEXORA_TRANSPORT=redis-streams + REDIS_URL + ioredis 설치.
  const createdTransport = await createTransport(transportConfigFromEnv());
  const transport = createdTransport.transport;
  console.log(`  transport: ${createdTransport.description.kind} (${createdTransport.description.deliveryGuarantee})`);

  // 엔트리포인트 책임: registry도 env로 매핑한다. 기본 memory(단일 프로세스).
  // 멀티 서버 배포는 NEXORA_REGISTRY=redis + REDIS_URL + ioredis 설치 — 그래야
  // 다른 프로세스가 등록한 에이전트 카드를 capability로 조회할 수 있다.
  const createdRegistry = await createAgentRegistry(registryConfigFromEnv());
  const registry = createdRegistry.registry;
  console.log(`  registry:  ${createdRegistry.description.kind}${createdRegistry.description.distributed ? ' (distributed)' : ''}`);
  const contextDir = path.resolve(options.contextDir);
  if (!fs.existsSync(contextDir)) {
    fs.mkdirSync(contextDir, { recursive: true });
    console.log(`Created context directory at ${contextDir}`);
  }
  const contextLoader = new CoreContextLoader({
    root: contextDir,
    defaultTools: ['read', 'grep', 'write', 'edit'],
    workdirBase: process.cwd(),
  });

  const llm = new PiAiProvider({
    provider: 'anthropic',
    model: options.model ?? 'claude-sonnet-4-5',
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const allTools = [createReadTool(), createGrepTool(), createWriteTool(), createEditTool()];
  const runningAgents: { name: string; shutdown: () => Promise<void> }[] = [];

  // ── Boot each agent ────────────────────────────────────────────────────
  for (const dir of agentDirs) {
    const configPath = path.join(agentsDir, dir.name, 'dist', 'agent.config.js');
    if (!fs.existsSync(configPath)) {
      console.warn(`  skip ${dir.name} (not built — run 'pnpm build' first)`);
      continue;
    }

    try {
      const configUrl = pathToFileURL(configPath).href;
      const mod = await import(configUrl) as { default: import('@dongkseo/contracts').AgentCard };
      const card = mod.default;

      const running = await bootstrapAgent({
        card,
        contextLoader,
        transport,
        registry,
        createRuntime: ({ context }) => {
          const allowed = context.tools.length > 0 ? new Set(context.tools) : null;
          const tools = allowed ? allTools.filter(t => allowed.has(t.name)) : allTools;

          return new AgentRunner({
            architecture: createReactArchitecture({
              systemPrompt: context.systemPrompt,
              model: context.limits.model || options.model,
              maxTokens: context.limits.maxTokens,
            }),
            llm,
            tools: new CoreToolExecutor({
              tools,
              context: {
                tenantId: context.tenantId,
                workdir: context.runtime.workdir,
                secrets: { get: async () => undefined },
                logger: console,
              },
            }),
            idleTimeoutMs: context.limits.maxExecutionMs,
          });
        },
        toAgentInput: (env) => {
          const payload = env.payload as {
            prompt?: string;
            images?: { data: string; mimeType: string }[];
            files?: { name?: string; data: string; mimeType: string; size?: number }[];
            history?: { role: 'user' | 'assistant'; content: string }[];
          };
          return {
            prompt: payload.prompt ?? '',
            images: payload.images?.map(i => ({
              type: 'image' as const,
              data: i.data,
              mimeType: i.mimeType,
            })),
            files: payload.files?.map(f => ({ type: 'file' as const, ...f })),
            history: payload.history,
          };
        },
      });

      runningAgents.push({ name: card.name, shutdown: running.shutdown.bind(running) });
      console.log(`  ✓ ${card.name} (${card.subscribes.join(', ')})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${dir.name}: ${msg}`);
    }
  }

  if (runningAgents.length === 0) {
    console.error('No agents loaded. Exiting.');
    await createdRegistry.close();
    await createdTransport.close();
    process.exit(1);
  }

  // ── Gateway ────────────────────────────────────────────────────────────
  // Default topic: first agent's first subscribe topic
  const defaultTopic = agentDirs.length > 0
    ? topic(`${agentDirs[0].name}.requested`)
    : topic('agent.requested');

  const gatewayRouter = new GatewayRouter({
    transport,
    defaultTopic: defaultTopic as import('@dongkseo/contracts').TopicString,
    timeoutMs: 120_000,
  });

  const adapter = new HttpAdapter({
    port: options.port,
    host: '0.0.0.0',
    resolveTenant: (req) => (req.headers['x-tenant-id'] as string) ?? 'default',
  });

  await adapter.start(gatewayRouter);

  console.log(`
╔══════════════════════════════════════════════════════╗
║  nexora dev                                          ║
║                                                      ║
║  Agents: ${String(runningAgents.length).padEnd(44)}║
${runningAgents.map(a => `║    · ${a.name.padEnd(46)}║`).join('\n')}
║                                                      ║
║  Gateway: http://localhost:${String(adapter.port()).padEnd(25)}║
║  Health:  http://localhost:${String(adapter.port()).padEnd(7)}/health              ║
║                                                      ║
║  Press Ctrl+C to stop.                               ║
╚══════════════════════════════════════════════════════╝
`);

  // ── Shutdown ───────────────────────────────────────────────────────────
  const shutdown = async (): Promise<void> => {
    console.log('\nShutting down...');
    await adapter.stop();
    for (const agent of runningAgents) {
      await agent.shutdown();
    }
    await createdRegistry.close();
    await createdTransport.close();
    console.log('Done.');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

/**
 * env → transport config 매핑. env를 읽는 책임은 엔트리포인트에 있다
 * (프레임워크 @dongkseo/transport는 process.env를 모른다). 알 수 없는
 * NEXORA_TRANSPORT 값은 여기서 거른다.
 *
 *   NEXORA_TRANSPORT      'local'(기본) | 'redis-streams' | 'redis-pubsub'
 *   REDIS_URL             redis://host:port (redis-* 에 필수)
 *   NEXORA_STREAM_PREFIX  스트림/채널 키 prefix
 *   NEXORA_CONSUMER_NAME  redis-streams 컨슈머 식별자
 */
function transportConfigFromEnv(): import('@dongkseo/transport').CreateTransportOptions {
  const raw = process.env.NEXORA_TRANSPORT?.trim().toLowerCase();
  let kind: import('@dongkseo/transport').TransportKind = 'local';
  if (raw === 'redis-streams' || raw === 'redis' || raw === 'streams') kind = 'redis-streams';
  else if (raw === 'redis-pubsub' || raw === 'pubsub') kind = 'redis-pubsub';
  else if (raw && raw !== 'local') {
    throw new Error(`Unknown NEXORA_TRANSPORT="${raw}". Use 'local', 'redis-streams', or 'redis-pubsub'.`);
  }
  return {
    kind,
    redisUrl: process.env.REDIS_URL,
    prefix: process.env.NEXORA_STREAM_PREFIX,
    consumerName: process.env.NEXORA_CONSUMER_NAME,
  };
}

/**
 * env → registry config 매핑. transport와 동일 원칙: env는 엔트리포인트가 읽고
 * 프레임워크(@dongkseo/registry)는 명시적 config만 받는다. 기본은 memory —
 * 멀티 서버 배포에서만 redis로 올린다(transport와 독립적으로 설정).
 *
 *   NEXORA_REGISTRY         'memory'(기본) | 'redis'
 *   REDIS_URL               redis://host:port (redis 에 필수, transport와 공유)
 *   NEXORA_REGISTRY_PREFIX  레지스트리 키 prefix
 *   NEXORA_REGISTRY_TTL_MS  카드 TTL(ms) — 이 시간 안에 heartbeat가 없으면 evict
 */
function registryConfigFromEnv(): import('@dongkseo/registry').CreateRegistryOptions {
  const raw = process.env.NEXORA_REGISTRY?.trim().toLowerCase();
  let kind: import('@dongkseo/registry').RegistryKind = 'memory';
  if (raw === 'redis') kind = 'redis';
  else if (raw && raw !== 'memory') {
    throw new Error(`Unknown NEXORA_REGISTRY="${raw}". Use 'memory' or 'redis'.`);
  }
  const ttlRaw = process.env.NEXORA_REGISTRY_TTL_MS;
  const ttlMs = ttlRaw ? Number(ttlRaw) : undefined;
  if (ttlMs !== undefined && !Number.isFinite(ttlMs)) {
    throw new Error(`Invalid NEXORA_REGISTRY_TTL_MS="${ttlRaw}". Must be a number (ms).`);
  }
  return {
    kind,
    redisUrl: process.env.REDIS_URL,
    prefix: process.env.NEXORA_REGISTRY_PREFIX,
    ttlMs,
  };
}
