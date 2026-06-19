import { getProviders, getModels, getEnvApiKey } from '@earendil-works/pi-ai';
import type { KnownProvider } from '@earendil-works/pi-ai';

/**
 * Model catalog enumeration for the Multica `pi` protocol_family backend.
 *
 * Multica discovers a `pi` runtime's models by spawning `<cmd> --list-models`
 * and parsing one `provider/model` id per stdout line (see parsePiModels in
 * server/pkg/agent/models.go). This module produces that id list from the
 * underlying @earendil-works/pi-ai catalog.
 *
 * pi-ai ships ~970 models across ~35 providers — dumping all of them makes for
 * an unusable picker, so by default we list only providers that have a
 * resolvable API key in the environment (i.e. ones the agent can actually
 * run). When none are credentialed we fall back to a single provider so the
 * picker is never empty.
 */

export interface ListAvailableModelsOptions {
  /**
   * Restrict to providers with a resolvable env API key. Default true.
   * Note: env-key detection (pi-ai `getEnvApiKey`) does not cover OAuth-only
   * providers such as github-copilot / openai-codex — those are excluded by
   * this filter even when usable. Set false to enumerate every provider.
   */
  credentialedOnly?: boolean;
  /** Provider listed when nothing is credentialed. Default 'anthropic'. */
  fallbackProvider?: string;
}

/**
 * Return `provider/model` ids for the Multica pi `--list-models` contract.
 * Pure aside from reading process.env via pi-ai's key detection.
 */
export function listAvailableModels(options: ListAvailableModelsOptions = {}): string[] {
  const credentialedOnly = options.credentialedOnly ?? true;
  const fallbackProvider = options.fallbackProvider ?? 'anthropic';

  const out: string[] = [];
  const seen = new Set<string>();

  const collect = (provider: KnownProvider): number => {
    let models: ReturnType<typeof getModels>;
    try {
      models = getModels(provider);
    } catch {
      return 0;
    }
    let added = 0;
    for (const m of models) {
      const id = `${provider}/${m.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      added++;
    }
    return added;
  };

  let credentialedCount = 0;
  for (const provider of getProviders()) {
    if (credentialedOnly) {
      let hasKey = false;
      try {
        hasKey = !!getEnvApiKey(provider);
      } catch {
        hasKey = false;
      }
      if (!hasKey) continue;
    }
    if (collect(provider) > 0) credentialedCount++;
  }

  if (credentialedCount === 0) {
    collect(fallbackProvider as KnownProvider);
  }

  return out;
}
