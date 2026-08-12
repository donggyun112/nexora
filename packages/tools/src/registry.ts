/**
 * ToolRegistry — 도구 등록/필터/조립.
 *
 * 참고: assembleToolPool 패턴.
 *
 * 사용:
 *   const registry = new ToolRegistry();
 *   registry.register(execTool);
 *   registry.register(readTool);
 *   const filtered = registry.assemble({ allowed: ['Bash'] });
 */

import type { ToolDefinition } from '@dongkseo/contracts';

export interface ToolFilter {
  /** 허용할 도구 이름 (지정 시 화이트리스트) */
  allowed?: string[];
  /** 차단할 도구 이름 (지정 시 블랙리스트) */
  blocked?: string[];
  /** 이름 패턴으로 필터 */
  pattern?: RegExp;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  /** 도구 등록 (이미 있으면 덮어쓰기) */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /** 여러 도구 한 번에 등록 */
  registerAll(tools: ToolDefinition[]): void {
    for (const tool of tools) this.register(tool);
  }

  /** 도구 제거 */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** 단일 도구 조회 */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** 도구 존재 여부 */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 등록된 모든 도구 */
  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** 등록된 도구 이름 목록 */
  names(): string[] {
    return Array.from(this.tools.keys());
  }

  /** 등록된 도구 수 */
  size(): number {
    return this.tools.size;
  }

  /**
   * 필터 기준으로 도구를 조립.
   * 에이전트별 허용 도구 셋을 만들 때 사용.
   *
   * 우선순위: checkAvailability → pattern → blocked → allowed → sort
   */
  assemble(filter: ToolFilter = {}): ToolDefinition[] {
    let tools = this.list();

    // Runtime availability gating (hermes check_fn) — hide unavailable tools
    // from the LLM schema entirely to prevent hallucinated calls.
    tools = tools.filter(t => !t.checkAvailability || t.checkAvailability());

    if (filter.pattern) {
      tools = tools.filter(t => filter.pattern!.test(t.name));
    }

    if (filter.blocked && filter.blocked.length > 0) {
      const blocked = new Set(filter.blocked);
      tools = tools.filter(t => !blocked.has(t.name));
    }

    if (filter.allowed && filter.allowed.length > 0) {
      const allowed = new Set(filter.allowed);
      tools = tools.filter(t => allowed.has(t.name));
    }

    // Deterministic sort for prompt-cache stability (claude-code pattern).
    // LLM APIs cache by tool schema prefix — unstable order = cache miss.
    tools.sort((a, b) => a.name.localeCompare(b.name));

    return tools;
  }

  /** 모든 도구 제거 */
  clear(): void {
    this.tools.clear();
  }
}

// ─── Tool Groups (openclaw pattern) ──────────────────────────────────────

/**
 * Named tool groups for use in allow/deny policies.
 * Groups use "group:" prefix in policy strings.
 *
 * Usage:
 * ```ts
 * const fsTools = TOOL_GROUPS['group:fs']; // ['read', 'write', 'edit', 'grep', 'glob']
 * const resolved = resolveToolNames(['read', 'group:runtime']); // ['read', 'Bash']
 * ```
 */
export const TOOL_GROUPS: Readonly<Record<string, readonly string[]>> = {
  'group:fs': ['read', 'write', 'edit', 'grep', 'glob'],
  'group:runtime': ['Bash'],
  'group:web': ['web-search', 'web-fetch'],
  'group:memory': ['knowledge'],
  'group:agent': ['delegate', 'handraise'],
  'group:skills': ['skill'],
} as const;

/**
 * Resolve a mixed list of tool names and group references to flat tool names.
 * E.g. ['read', 'group:runtime'] → ['read', 'Bash']
 */
export function resolveToolNames(names: readonly string[]): string[] {
  const result = new Set<string>();
  for (const name of names) {
    const group = TOOL_GROUPS[name];
    if (group) { for (const t of group) result.add(t); }
    else result.add(name);
  }
  return [...result];
}

// ─── Tool Profiles (openclaw preset bundles) ─────────────────────────────

export type ToolProfileId = 'minimal' | 'coding' | 'full';

export const TOOL_PROFILES: Record<ToolProfileId, { allow?: string[] }> = {
  minimal: { allow: ['read', 'grep'] },
  coding: { allow: ['group:fs', 'group:runtime', 'group:memory', 'group:skills'] },
  full: {},  // no restrictions
};

/**
 * Get the resolved tool name list for a profile.
 * 'full' returns undefined (no filter = all tools allowed).
 */
export function resolveProfile(profileId: ToolProfileId): string[] | undefined {
  const profile = TOOL_PROFILES[profileId];
  if (!profile.allow) return undefined;
  return resolveToolNames(profile.allow);
}

// ─── Layered Tool Policy Pipeline (openclaw pattern) ─────────────────────

/**
 * A single policy layer. Each layer can further restrict the tool set
 * from the previous layer — it can never ADD tools back.
 *
 * Layers are applied sequentially:
 *   global → tenant → agent → adapter
 */
export interface ToolPolicyLayer {
  /** Human-readable label for debugging (e.g. "tenant.startup") */
  label: string;
  /** Allowed tool names or group references. Undefined = no restriction from this layer. */
  allow?: readonly string[];
  /** Blocked tool names or group references. Applied after allow. */
  deny?: readonly string[];
}

/**
 * Apply a pipeline of policy layers to a tool name list.
 * Each layer further restricts — never adds back.
 *
 * Usage:
 * ```ts
 * const pipeline: ToolPolicyLayer[] = [
 *   { label: 'global', allow: ['group:fs', 'group:runtime', 'group:agent'] },
 *   { label: 'tenant.startup', deny: ['Bash'] },
 *   { label: 'agent.reviewer', allow: ['read', 'grep', 'knowledge'] },
 * ];
 * const allowed = applyToolPolicyPipeline(allToolNames, pipeline);
 * const tools = registry.assemble({ allowed });
 * ```
 */
export function applyToolPolicyPipeline(
  toolNames: string[],
  layers: readonly ToolPolicyLayer[],
): string[] {
  let current = new Set(toolNames);

  for (const layer of layers) {
    if (layer.allow) {
      const resolved = new Set(resolveToolNames(layer.allow));
      current = new Set([...current].filter(t => resolved.has(t)));
    }
    if (layer.deny) {
      const resolved = new Set(resolveToolNames(layer.deny));
      for (const t of resolved) current.delete(t);
    }
  }

  return [...current];
}

export interface ResolveToolPolicyOptions {
  /** Tool names currently available in the registry/runtime. */
  availableToolNames: readonly string[];
  /** Prebuilt layers. Apply these in the given order. */
  layers?: readonly ToolPolicyLayer[];
  /** AgentCard-declared tools. Empty/undefined means no card restriction. */
  cardTools?: readonly string[];
  /** ContextLoader-resolved tools. Empty/undefined means no context restriction. */
  contextTools?: readonly string[];
  /** Adapter-facing final restriction, applied last. */
  adapter?: {
    allow?: readonly string[];
    deny?: readonly string[];
    label?: string;
  };
}

export interface ResolvedToolPolicy {
  /** Final allowed tool names after all layers are applied. */
  allowedToolNames: string[];
  /** Effective layer list, useful for logging and audit records. */
  layers: ToolPolicyLayer[];
}

/**
 * Resolve the final tool list through the shared policy path.
 *
 * Layer order is:
 *   explicit layers (global/tenant/agent/etc.) → context → card → adapter
 *
 * Empty allow lists are treated as "no restriction" to preserve the existing
 * convention where `context.tools = []` means the tenant did not set a policy.
 */
export function resolveToolPolicy(options: ResolveToolPolicyOptions): ResolvedToolPolicy {
  const layers: ToolPolicyLayer[] = [...(options.layers ?? [])];

  if (options.contextTools && options.contextTools.length > 0) {
    layers.push({ label: 'context', allow: options.contextTools });
  }
  if (options.cardTools && options.cardTools.length > 0) {
    layers.push({ label: 'agent.card', allow: options.cardTools });
  }
  if (
    options.adapter &&
    ((options.adapter.allow && options.adapter.allow.length > 0) ||
      (options.adapter.deny && options.adapter.deny.length > 0))
  ) {
    layers.push({
      label: options.adapter.label ?? 'adapter',
      allow: options.adapter.allow,
      deny: options.adapter.deny,
    });
  }

  const base = [...new Set(options.availableToolNames)].sort((a, b) => a.localeCompare(b));
  return {
    allowedToolNames: applyToolPolicyPipeline(base, layers),
    layers,
  };
}

export function assembleToolsWithPolicy(
  registry: ToolRegistry,
  options: Omit<ResolveToolPolicyOptions, 'availableToolNames'>,
): ResolvedToolPolicy & { tools: ToolDefinition[] } {
  const policy = resolveToolPolicy({
    ...options,
    availableToolNames: registry.names(),
  });

  return {
    ...policy,
    tools: policy.allowedToolNames.length === 0
      ? []
      : registry.assemble({ allowed: policy.allowedToolNames }),
  };
}

// ─── Toolset Grouping ────────────────────────────────────────────────────

export interface ToolsetDefinition {
  /** Tool names in this toolset */
  tools: string[];
  /** Other toolsets to include (recursive composition) */
  includes?: string[];
}

/**
 * ToolsetRegistry — named groups of tools for multi-tenant/multi-adapter use.
 *
 * Usage:
 * ```ts
 * const toolsets = new ToolsetRegistry();
 * toolsets.register('base', { tools: ['read', 'grep'] });
 * toolsets.register('dev', { tools: ['Bash', 'edit'], includes: ['base'] });
 * toolsets.register('discord-agent', { tools: ['web-search'], includes: ['dev'] });
 *
 * const names = toolsets.resolve('discord-agent');
 * // → ['read', 'grep', 'Bash', 'edit', 'web-search']
 *
 * const tools = toolRegistry.assemble({ allowed: names });
 * ```
 */
export class ToolsetRegistry {
  private readonly toolsets = new Map<string, ToolsetDefinition>();

  register(name: string, def: ToolsetDefinition): void {
    this.toolsets.set(name, def);
  }

  unregister(name: string): void {
    this.toolsets.delete(name);
  }

  get(name: string): ToolsetDefinition | undefined {
    return this.toolsets.get(name);
  }

  list(): string[] {
    return [...this.toolsets.keys()];
  }

  /**
   * Resolve a toolset name to a flat array of tool names.
   * Recursively resolves `includes`, with cycle detection.
   */
  resolve(name: string): string[] {
    const result = new Set<string>();
    const visited = new Set<string>();
    this.resolveRecursive(name, result, visited);
    return [...result];
  }

  private resolveRecursive(
    name: string,
    result: Set<string>,
    visited: Set<string>,
  ): void {
    if (visited.has(name)) return; // cycle detection
    visited.add(name);

    const def = this.toolsets.get(name);
    if (!def) return;

    // Resolve includes first (base tools come first)
    if (def.includes) {
      for (const inc of def.includes) {
        this.resolveRecursive(inc, result, visited);
      }
    }

    for (const tool of def.tools) {
      result.add(tool);
    }
  }
}
