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

// ─── Extension manifest (openclaw pattern) ──────────────────────────────

/** Static manifest file — enables discovery without loading code. */
export interface ExtensionManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  /** Entry point relative to manifest file. Default: 'index.js' */
  main?: string;
  /** JSON Schema for extension config */
  configSchema?: Record<string, unknown>;
  /** Plugin kind slot (e.g. 'memory' — only one active at a time) */
  kind?: string;
}

/**
 * Read a nexora.extension.json manifest. Returns null if not found.
 */
async function readManifest(dir: string): Promise<ExtensionManifest | null> {
  const manifestPath = path.join(dir, 'nexora.extension.json');
  try {
    const raw = await fsp.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as ExtensionManifest;
    if (!parsed.id || !parsed.name) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Load and activate extensions from multiple sources.
 * Returns a registry with all discovered extensions.
 *
 * Discovery order:
 * 1. Programmatic extensions (options.extensions)
 * 2. Filesystem: directories with nexora.extension.json (manifest-first)
 * 3. Filesystem: standalone .js/.mjs files (legacy)
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

      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.resolve(dir, entry.name);
        const stat = await fsp.lstat(entryPath);
        if (stat.isSymbolicLink()) continue;

        if (stat.isDirectory()) {
          // Manifest-based discovery: dir/nexora.extension.json
          const manifest = await readManifest(entryPath);
          if (!manifest) continue;

          const mainFile = path.join(entryPath, manifest.main ?? 'index.js');
          if (!fs.existsSync(mainFile)) continue;

          try {
            const mod = await import(mainFile) as {
              default?: NexoraExtension;
              extension?: NexoraExtension;
            };
            const ext = mod.default ?? mod.extension;
            if (ext && typeof ext === 'object') {
              // Merge manifest metadata into extension
              ext.name = ext.name ?? manifest.name;
              ext.version = ext.version ?? manifest.version;
              (ext as NexoraExtension & { manifest?: ExtensionManifest }).manifest = manifest;
              registry.register(ext);
            }
          } catch {
            // Skip extensions that fail to load
          }
        } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
          // Legacy: standalone .js files
          try {
            const mod = await import(entryPath) as {
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
