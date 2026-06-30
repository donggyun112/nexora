// @ts-nocheck — like dev.ts, this file dynamically imports workspace packages
// that are NOT build-time dependencies of @dongkseo/cli. They resolve at
// runtime inside the Nexora workspace (and from node_modules when published).
/**
 * nexora headless (one-shot) — Multica `pi` protocol_family backend.
 *
 * Multica's daemon drives a `pi` backend by spawning the configured command as:
 *
 *   nexora -p --mode json --session <path> [--provider <p>] [--model <m>]
 *          [--append-system-prompt <s>] <...customArgs> "<prompt>"
 *
 * and parsing exactly one JSON event per line on stdout. This entry point runs
 * a single ReAct agent turn in the current working directory and streams the
 * Multica `pi` wire format via `drivePi()` from @dongkseo/core.
 *
 * The prompt is ALWAYS the final positional argument (see pi.go buildPiArgs),
 * so we take argv's last element as the prompt and parse the rest as flags.
 *
 * Wire contract reference: server/pkg/agent/pi.go in the Multica repo.
 */

import fs from 'node:fs';

interface HeadlessArgs {
  prompt: string;
  sessionPath?: string;
  provider: string;
  model: string;
  systemPrompt?: string;
}

interface HeadlessProviderSpec {
  provider: string;
  model: string;
}

export class FixedHeadlessModelProvider {
  constructor(
    private readonly inner: { stream: Function; complete: Function },
    private readonly model: string,
  ) {}

  stream(messages: unknown[], options?: { model?: string }): AsyncGenerator<unknown> {
    return this.inner.stream(messages, this.withModel(options));
  }

  complete(messages: unknown[], options?: { model?: string }): Promise<unknown> {
    return this.inner.complete(messages, this.withModel(options));
  }

  private withModel(options?: { model?: string }): Record<string, unknown> {
    return { ...(options ?? {}), model: this.model };
  }
}

function splitProviderModel(id: string): HeadlessProviderSpec | null {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) return null;
  return { provider: id.slice(0, slash), model: id.slice(slash + 1) };
}

export function headlessProviderName(spec: HeadlessProviderSpec): string {
  return `${spec.provider}/${spec.model}`;
}

const CODEX_FALLBACK_MODEL_PREFERENCE = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.3-codex-spark',
] as const;

export function selectHeadlessCodexFallbackModel(modelIds: readonly string[]): string | undefined {
  const codexModels = modelIds
    .map(splitProviderModel)
    .filter((spec): spec is HeadlessProviderSpec => Boolean(spec) && spec.provider === 'openai-codex')
    .map((spec) => spec.model);
  if (codexModels.length === 0) return undefined;
  for (const preferred of CODEX_FALLBACK_MODEL_PREFERENCE) {
    if (codexModels.includes(preferred)) return preferred;
  }
  return [...codexModels].sort().at(-1);
}

export function addHeadlessModelId(modelIds: readonly string[], id: string | undefined): string[] {
  const out = [...modelIds];
  if (id && !out.includes(id)) out.push(id);
  return out;
}

export function buildHeadlessSandboxTools<T>(
  sandboxToolDefinitions: (options: { exec: { allowList: string[]; allowShell: boolean } }) => T[],
): T[] {
  return sandboxToolDefinitions({
    exec: {
      allowList: ['*'],
      allowShell: true,
    },
  });
}

export function createHeadlessWorkspaceProvider(deps: {
  cwd: string;
  isSandboxSupported: () => boolean;
  createSandboxProvider: (options: { root: string; cleanup: 'keep' }) => unknown;
  HostWorkspaceProvider: new (options: { root: string }) => unknown;
}): unknown {
  return deps.isSandboxSupported()
    ? deps.createSandboxProvider({ root: deps.cwd, cleanup: 'keep' })
    : new deps.HostWorkspaceProvider({ root: deps.cwd });
}

export function buildHeadlessProviderSpecs(
  primary: HeadlessProviderSpec,
  modelIds: readonly string[],
): HeadlessProviderSpec[] {
  const primaryKey = headlessProviderName(primary);
  const seen = new Set([primaryKey]);
  const crossProvider: HeadlessProviderSpec[] = [];
  const sameProvider: HeadlessProviderSpec[] = [];

  for (const id of modelIds) {
    const spec = splitProviderModel(id);
    if (!spec) continue;
    const key = headlessProviderName(spec);
    if (seen.has(key)) continue;
    seen.add(key);
    if (spec.provider === primary.provider) sameProvider.push(spec);
    else crossProvider.push(spec);
  }

  return [primary, ...crossProvider, ...sameProvider];
}

/**
 * Parse the pi-style argv. Known value-flags are consumed; everything else
 * (incl. `-p`, `--mode`, user custom args) is ignored for runtime purposes.
 * The prompt is the trailing positional, which Multica always appends last.
 */
function parseHeadlessArgs(argv: string[]): HeadlessArgs {
  // Default provider/model mirror `nexora dev`.
  let provider = 'anthropic';
  let model = 'claude-sonnet-4-5';
  let providerExplicit = false;
  let sessionPath: string | undefined;
  let systemPrompt: string | undefined;

  if (argv.length === 0) {
    throw new Error('no prompt provided');
  }
  // Prompt is the last argument (pi.go appends it after all flags/custom args).
  const prompt = argv[argv.length - 1];
  const flagArgs = argv.slice(0, argv.length - 1);

  for (let i = 0; i < flagArgs.length; i++) {
    const a = flagArgs[i];
    switch (a) {
      case '--session':
        sessionPath = flagArgs[++i];
        break;
      case '--provider':
        provider = flagArgs[++i] ?? provider;
        providerExplicit = true;
        break;
      case '--model': {
        const v = flagArgs[++i] ?? model;
        // Multica may pass "provider/model"; split it (mirrors splitPiModel).
        const slash = v.indexOf('/');
        if (slash >= 0) {
          provider = v.slice(0, slash).trim() || provider;
          providerExplicit = true;
          model = v.slice(slash + 1).trim();
        } else {
          model = v;
        }
        break;
      }
      case '--append-system-prompt':
        systemPrompt = flagArgs[++i];
        break;
      case '--mode':
        ++i; // consume value (expected "json"); we always emit json
        break;
      // -p / --print and any unknown custom flags are ignored here.
      default:
        break;
    }
  }

  void providerExplicit;
  return { prompt, sessionPath, provider, model, systemPrompt };
}

/**
 * Entry point for `nexora -p ...`. Runs one agent turn and emits the Multica
 * `pi` event stream on stdout (and appends it to --session if given).
 * Exits non-zero when the turn fails so Multica records a failed task.
 */
export async function runHeadless(argv: string[]): Promise<void> {
  const {
    AgentRunner,
    CoreToolExecutor,
    PiAiProvider,
    FallbackLLMProvider,
    createSandboxProvider,
    HostWorkspaceProvider,
    isSandboxSupported,
    drivePi,
    InMemoryBudgetTracker,
    createBudgetMiddleware,
    listAvailableModels,
  } =
    (await import('@dongkseo/core' as string)) as typeof import('@dongkseo/core');
  const { createReactArchitecture } =
    (await import('@dongkseo/architectures' as string)) as typeof import('@dongkseo/architectures');
  const { sandboxToolDefinitions } =
    (await import('@dongkseo/tools' as string)) as typeof import('@dongkseo/tools');
  const { resolveCodexApiKey } =
    (await import('@dongkseo/adapters' as string)) as typeof import('@dongkseo/adapters');

  // Helper to emit a single pi wire line straight to stdout (used for fatal
  // setup errors that occur before drivePi() takes over).
  const emitRaw = (ev: unknown): void => void process.stdout.write(JSON.stringify(ev) + '\n');

  let parsed: HeadlessArgs;
  try {
    parsed = parseHeadlessArgs(argv);
  } catch (err) {
    emitRaw({ type: 'agent_start' });
    emitRaw({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    emitRaw({ type: 'turn_end', message: { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } });
    process.exit(1);
  }

  // Session sink: Multica pre-creates the --session file and treats it as the
  // resumable event log. Append each wire line there as well as stdout.
  let appendSession: ((line: string) => void) | undefined;
  if (parsed.sessionPath) {
    try {
      const fd = fs.openSync(parsed.sessionPath, 'a');
      appendSession = (line: string) => {
        try {
          fs.writeSync(fd, line + '\n');
        } catch {
          /* best-effort; stdout is the source of truth for Multica */
        }
      };
    } catch {
      /* missing/unwritable session file is non-fatal: stdout still drives Multica */
    }
  }

  let runner: import('@dongkseo/core').AgentRunner;
  try {
    let codexApiKey: string | undefined;
    let codexFallbackModel: string | undefined;
    try {
      codexApiKey = await resolveCodexApiKey();
      codexFallbackModel = selectHeadlessCodexFallbackModel(
        listAvailableModels({ credentialedOnly: false, fallbackProvider: parsed.provider }),
      );
    } catch {
      /* Codex OAuth is optional; keep the env-key model catalog when unavailable. */
    }
    const apiKeyFor = (provider: string): string | undefined =>
      provider === 'openai-codex'
        ? codexApiKey
        : provider === 'anthropic'
          ? process.env.ANTHROPIC_API_KEY
          : undefined;
    const modelIds = addHeadlessModelId(
      listAvailableModels({ fallbackProvider: parsed.provider }),
      codexFallbackModel ? `openai-codex/${codexFallbackModel}` : undefined,
    );
    const providerSpecs = buildHeadlessProviderSpecs(
      { provider: parsed.provider, model: parsed.model },
      modelIds,
    );
    const providers = providerSpecs.map((spec) => ({
      name: headlessProviderName(spec),
      provider: new FixedHeadlessModelProvider(
        new PiAiProvider({
          provider: spec.provider,
          model: spec.model,
          apiKey: apiKeyFor(spec.provider),
        }),
        spec.model,
      ),
    }));
    const llm = providers.length > 1
      ? new FallbackLLMProvider({
          providers,
          rateLimitRetryMs: 0,
          onFallback: (from, to, reason) => console.error(`[llm-fallback] ${from} -> ${to}: ${reason}`),
        })
      : providers[0].provider;

    const tools = buildHeadlessSandboxTools(sandboxToolDefinitions);
    const workspaceProvider = createHeadlessWorkspaceProvider({
      cwd: process.cwd(),
      isSandboxSupported,
      createSandboxProvider,
      HostWorkspaceProvider,
    });

    // Feed the middleware pipeline (previously plumbed into the harness but left
    // empty). Cost recording only, with the default NOOP logger — headless stdout
    // is reserved for the pi wire protocol, so no middleware may write there.
    const budgetTracker = new InMemoryBudgetTracker();

    runner = new AgentRunner({
      architecture: createReactArchitecture({
        systemPrompt: parsed.systemPrompt,
        model: parsed.model,
      }),
      llm,
      workspaceProvider,
      middlewares: [
        createBudgetMiddleware({
          tracker: budgetTracker,
          agentName: 'headless',
          tenantId: 'default',
          model: parsed.model,
        }),
      ],
      tools: new CoreToolExecutor({
        tools,
        context: {
          tenantId: 'default',
          workdir: process.cwd(),
          secrets: { get: async () => undefined },
          logger: console,
        },
      }),
    });
  } catch (err) {
    // Provider/model construction can throw (e.g. unknown model id).
    emitRaw({ type: 'agent_start' });
    emitRaw({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    emitRaw({ type: 'turn_end', message: { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } });
    process.exit(1);
  }

  const result = await drivePi({
    run: () => runner.execute({ prompt: parsed.prompt }),
    appendSession,
  });

  if (result.status === 'failed') {
    process.exit(1);
  }
}

/**
 * Entry point for `nexora --list-models`. Multica discovers a `pi` runtime's
 * model catalog by parsing one `provider/model` id per stdout line. Emits the
 * credentialed pi-ai catalog (see listAvailableModels in @dongkseo/core).
 */
export async function runListModels(): Promise<void> {
  const { listAvailableModels } =
    (await import('@dongkseo/core' as string)) as typeof import('@dongkseo/core');
  const ids = listAvailableModels();
  if (ids.length > 0) {
    process.stdout.write(ids.join('\n') + '\n');
  }
}
