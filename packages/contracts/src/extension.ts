/**
 * NexoraExtension — unified plugin interface.
 *
 * A single extension can register tools, middleware, store backends,
 * and event handlers. This replaces the need to wire each subsystem
 * individually.
 *
 * Discovery: extensions are loaded from:
 * 1. agents/{name}/extensions/*.ts (per-agent)
 * 2. ~/.nexora/extensions/ (global)
 * 3. Programmatic registration via ExtensionRegistry
 */

import type { ToolDefinition } from './tool.js';
import type { AgentEvent } from './agent.js';

export interface ExtensionContext {
  /** Data directory for persistent storage */
  dataDir: string;
  /** Current tenant ID (if multi-tenant) */
  tenantId?: string;
}

export interface NexoraExtension {
  /** Unique extension name */
  name: string;
  /** Version string */
  version?: string;
  /** Additional tools this extension provides */
  tools?: ToolDefinition[];
  /** Middleware hooks (matches AgentMiddleware interface from core) */
  middleware?: {
    name: string;
    beforeExecution?(ctx: unknown): Promise<void> | void;
    afterExecution?(ctx: unknown): Promise<void> | void;
    beforeToolCall?(ctx: unknown): Promise<void> | void;
    afterToolCall?(ctx: unknown): Promise<void> | void;
    beforeLLMCall?(ctx: unknown): Promise<void> | void;
    afterLLMCall?(ctx: unknown): Promise<void> | void;
  };
  /** Named toolset this extension contributes to */
  toolset?: string;
  /** Event handler called for every agent event */
  onAgentEvent?: (event: AgentEvent) => void;
  /** Called when the extension is activated */
  activate?(ctx: ExtensionContext): void | Promise<void>;
  /** Called when the extension is deactivated */
  deactivate?(): void | Promise<void>;
}

export interface ExtensionRegistry {
  register(extension: NexoraExtension): void;
  unregister(name: string): void;
  get(name: string): NexoraExtension | undefined;
  list(): readonly NexoraExtension[];
  /** Get all tools from all registered extensions */
  collectTools(): ToolDefinition[];
}
