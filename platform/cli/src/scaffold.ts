/**
 * Agent scaffolding — agents/{name}/ 디렉토리 생성.
 *
 * 생성되는 파일:
 *   agents/{name}/
 *     agent.config.ts    # defineAgent() 정의
 *     index.ts           # bootstrap entry point
 *     persona.md         # 페르소나 문서
 *     README.md          # 사용 안내
 */

import fs from 'node:fs';
import path from 'node:path';

export interface ScaffoldOptions {
  /** 에이전트 이름 (소문자, 하이픈 허용) */
  name: string;
  /** 출력 디렉토리 (기본 cwd/agents/{name}) */
  outDir?: string;
  /** 사용할 아키텍처 (기본 react) */
  architecture?: 'react' | 'deep-research' | 'plan-execute' | 'loop';
  /** 사용할 도구 목록 (기본 ['read', 'grep']) */
  tools?: string[];
  /** 강제 덮어쓰기 (기본 false) */
  force?: boolean;
}

export interface ScaffoldResult {
  outDir: string;
  files: string[];
}

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export async function scaffoldAgent(options: ScaffoldOptions): Promise<ScaffoldResult> {
  if (!NAME_PATTERN.test(options.name)) {
    throw new Error(`Invalid agent name "${options.name}". Use lowercase letters, digits, and hyphens.`);
  }

  const outDir = path.resolve(options.outDir ?? path.join(process.cwd(), 'agents', options.name));
  const architecture = options.architecture ?? 'react';
  const tools = options.tools ?? ['read', 'grep'];

  if (fs.existsSync(outDir) && !options.force) {
    const entries = fs.readdirSync(outDir);
    if (entries.length > 0) {
      throw new Error(`${outDir} already exists and is not empty. Use force=true to overwrite.`);
    }
  }

  fs.mkdirSync(outDir, { recursive: true });

  const files: string[] = [];

  const configFile = path.join(outDir, 'agent.config.ts');
  fs.writeFileSync(configFile, renderConfig(options.name, architecture, tools), 'utf-8');
  files.push(configFile);

  const indexFile = path.join(outDir, 'index.ts');
  fs.writeFileSync(indexFile, renderIndex(options.name), 'utf-8');
  files.push(indexFile);

  const personaFile = path.join(outDir, 'persona.md');
  fs.writeFileSync(personaFile, renderPersona(options.name), 'utf-8');
  files.push(personaFile);

  const readmeFile = path.join(outDir, 'README.md');
  fs.writeFileSync(readmeFile, renderReadme(options.name), 'utf-8');
  files.push(readmeFile);

  return { outDir, files };
}

// ─── templates ─────────────────────────────────────────────────────────────

function renderConfig(name: string, architecture: string, tools: string[]): string {
  return `import { defineAgent, topic } from '@nexora/contracts';

export default defineAgent({
  name: '${name}',
  version: '0.1.0',
  description: 'TODO: describe what ${name} does',
  architecture: '${architecture}',
  tools: ${JSON.stringify(tools)},
  capabilities: [],
  subscribes: [topic('${name}.requested')],
  publishes: [topic('${name}.completed')],
  // Schema enforcement: define these to get automatic payload validation.
  // Malformed inbound messages → <topic>.schema-rejected (agent never runs).
  // Malformed outbound results → <topic>.failed (agent bug detected early).
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
    },
    required: ['prompt'],
  },
});
`;
}

function renderIndex(name: string): string {
  const camel = toCamel(name);
  return `/**
 * ${name} — bootstrap entry point.
 *
 * Usage:
 *   const transport = new LocalTransport();
 *   const contextLoader = new CoreContextLoader({ root: 'context' });
 *   const llm = new PiAiProvider({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' });
 *   await start${camel}({ transport, contextLoader, llm, tools: [...] });
 */

import { bootstrapAgent, AgentRunner, CoreToolExecutor } from '@nexora/core';
import { createReactArchitecture } from '@nexora/architectures';
import type {
  Transport,
  ContextLoader,
  ToolDefinition,
  LLMProvider,
  SecretAccessor,
  ToolLogger,
} from '@nexora/contracts';
import card from './agent.config.js';

export interface Start${camel}Options {
  transport: Transport;
  contextLoader: ContextLoader;
  llm: LLMProvider;
  /** All tools the agent COULD use; per-tenant filtering is applied via context.tools */
  tools: ToolDefinition[];
  /** Tenant secret accessor — defaults to no-op */
  secrets?: SecretAccessor;
  /** Per-call logger — defaults to console */
  logger?: ToolLogger;
}

const NOOP_SECRETS: SecretAccessor = { get: async () => undefined };
const CONSOLE_LOGGER: ToolLogger = {
  info: (msg, data) => console.log(\`[${name}] \${msg}\`, data ?? ''),
  warn: (msg, data) => console.warn(\`[${name}] \${msg}\`, data ?? ''),
  error: (msg, data) => console.error(\`[${name}] \${msg}\`, data ?? ''),
};

export async function start${camel}(options: Start${camel}Options) {
  const secrets = options.secrets ?? NOOP_SECRETS;
  const logger = options.logger ?? CONSOLE_LOGGER;

  return bootstrapAgent({
    card,
    contextLoader: options.contextLoader,
    transport: options.transport,
    createRuntime: ({ context }) => {
      // Filter tools by the tenant's allowed list (if non-empty).
      const allowed = context.tools.length > 0 ? new Set(context.tools) : null;
      const tools = allowed
        ? options.tools.filter(t => allowed.has(t.name))
        : options.tools;

      return new AgentRunner({
        architecture: createReactArchitecture({
          systemPrompt: context.systemPrompt,
          model: context.limits.model,
          maxTokens: context.limits.maxTokens,
        }),
        llm: options.llm,
        tools: new CoreToolExecutor({
          tools,
          // ToolContext rebuilt per-request from the tenant's runtime context.
          context: {
            tenantId: context.tenantId,
            workdir: context.runtime.workdir,
            secrets,
            logger,
          },
        }),
        idleTimeoutMs: context.limits.maxExecutionMs,
      });
    },
    toAgentInput: (env) => {
      const payload = env.payload as { prompt?: string };
      return { prompt: payload.prompt ?? '' };
    },
  });
}
`;
}

function renderPersona(name: string): string {
  return `# ${name} persona

You are ${name}.

## Role
TODO: describe role and responsibilities.

## Style
- Be concise.
- Cite tool outputs when relevant.
- Ask for clarification only when truly necessary.
`;
}

function renderReadme(name: string): string {
  return `# ${name}

Generated by \`nexora create agent ${name}\`.

## Files
- \`agent.config.ts\` — AgentCard definition (subscribes / publishes / tools / architecture)
- \`index.ts\` — bootstrap entry point exporting \`start${toCamel(name)}()\`
- \`persona.md\` — agent persona (load via \`@nexora/context\` PersonaLoader)

## Run

\`\`\`ts
import { LocalTransport } from '@nexora/transport';
import { CoreContextLoader } from '@nexora/context';
import { PiAiProvider } from '@nexora/core';
import { createReadTool, createGrepTool } from '@nexora/tools';
import { start${toCamel(name)} } from './index.js';

const transport = new LocalTransport();
const contextLoader = new CoreContextLoader({ root: './context' });
const llm = new PiAiProvider({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' });

// Tenant context (systemPrompt, limits, workdir) is derived per-request from
// the ContextLoader — you only pass the tools plus optional secrets/logger.
const running = await start${toCamel(name)}({
  transport,
  contextLoader,
  llm,
  tools: [createReadTool(), createGrepTool()],
  // secrets: myVaultAdapter,  // optional, defaults to no-op
  // logger: customLogger,     // optional, defaults to console
});
\`\`\`
`;
}

function toCamel(name: string): string {
  return name
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
