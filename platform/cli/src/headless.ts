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
  const { AgentRunner, CoreToolExecutor, PiAiProvider, drivePi } =
    (await import('@dongkseo/core' as string)) as typeof import('@dongkseo/core');
  const { createReactArchitecture } =
    (await import('@dongkseo/architectures' as string)) as typeof import('@dongkseo/architectures');
  const { createReadTool, createGrepTool, createWriteTool, createEditTool } =
    (await import('@dongkseo/tools' as string)) as typeof import('@dongkseo/tools');

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
    const llm = new PiAiProvider({
      provider: parsed.provider,
      model: parsed.model,
      apiKey: parsed.provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : undefined,
    });

    const tools = [createReadTool(), createGrepTool(), createWriteTool(), createEditTool()];

    runner = new AgentRunner({
      architecture: createReactArchitecture({
        systemPrompt: parsed.systemPrompt,
        model: parsed.model,
      }),
      llm,
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
