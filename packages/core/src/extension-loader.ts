/**
 * ExtensionLoader — discover and activate NexoraExtension plugins.
 *
 * Discovery sources:
 * 1. Programmatic: registry.register(extension)
 * 2. Filesystem: agents/{name}/extensions/*.js
 * 3. Global: ~/.nexora/extensions/*.js
 *
 * Each extension can provide tools, middleware, and event handlers.
 * The loader collects them into a unified registry.
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import type {
  NexoraExtension,
  ExtensionContext,
  ExtensionRegistry,
  ToolDefinition,
} from '@nexora/contracts';

export class InMemoryExtensionRegistry implements ExtensionRegistry {
  private readonly extensions = new Map<string, NexoraExtension>();

  register(extension: NexoraExtension): void {
    if (this.extensions.has(extension.name)) {
      throw new Error(`Extension "${extension.name}" is already registered`);
    }
    this.extensions.set(extension.name, extension);
  }

  unregister(name: string): void {
    this.extensions.delete(name);
  }

  get(name: string): NexoraExtension | undefined {
    return this.extensions.get(name);
  }

  list(): readonly NexoraExtension[] {
    return [...this.extensions.values()];
  }

  collectTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const ext of this.extensions.values()) {
      if (ext.tools) tools.push(...ext.tools);
    }
    return tools;
  }
}

export interface ExtensionLoaderOptions {
  /** Directories to scan for extension .js files */
  searchDirs?: string[];
  /** Extensions to register programmatically */
  extensions?: NexoraExtension[];
  /** Context passed to extension.activate() */
  context: ExtensionContext;
}

/**
 * Load and activate extensions from multiple sources.
 * Returns a registry with all discovered extensions.
 */
export async function loadExtensions(
  options: ExtensionLoaderOptions,
): Promise<InMemoryExtensionRegistry> {
  const registry = new InMemoryExtensionRegistry();

  // Programmatic extensions
  if (options.extensions) {
    for (const ext of options.extensions) {
      registry.register(ext);
    }
  }

  // Filesystem discovery
  if (options.searchDirs) {
    for (const dir of options.searchDirs) {
      if (!fs.existsSync(dir)) continue;

      const entries = await fsp.readdir(dir);
      for (const entry of entries) {
        if (!entry.endsWith('.js') && !entry.endsWith('.mjs')) continue;

        const filePath = path.resolve(dir, entry);
        // Skip symlinks
        const stat = await fsp.lstat(filePath);
        if (stat.isSymbolicLink()) continue;

        try {
          const mod = await import(filePath) as {
            default?: NexoraExtension;
            extension?: NexoraExtension;
          };
          const ext = mod.default ?? mod.extension;
          if (ext && typeof ext === 'object' && ext.name) {
            registry.register(ext);
          }
        } catch {
          // Skip modules that fail to load
        }
      }
    }
  }

  // Activate all extensions
  for (const ext of registry.list()) {
    if (ext.activate) {
      try {
        await ext.activate(options.context);
      } catch {
        // Log but don't block other extensions
      }
    }
  }

  return registry;
}

/**
 * Deactivate all extensions in a registry.
 */
export async function unloadExtensions(registry: InMemoryExtensionRegistry): Promise<void> {
  for (const ext of registry.list()) {
    if (ext.deactivate) {
      try {
        await ext.deactivate();
      } catch {
        // Best effort
      }
    }
  }
}
