import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMChunk, LLMMessage, LLMOptions, LLMProvider, LLMResponse } from '@dongkseo/contracts';

const providerCalls: Array<{ provider: string; model: string; options?: LLMOptions }> = [];

function rateLimit(): Error & { status: number } {
  const err = new Error('rate limited') as Error & { status: number };
  err.status = 429;
  return err;
}

class FakePiAiProvider implements LLMProvider {
  constructor(private readonly options: { provider: string; model: string; apiKey?: string }) {}

  async *stream(_messages: LLMMessage[], options?: LLMOptions): AsyncGenerator<LLMChunk> {
    providerCalls.push({ provider: this.options.provider, model: this.options.model, options });
    if (this.options.provider === 'anthropic') throw rateLimit();
    yield { type: 'done', content: 'ok', stopReason: 'end_turn' };
  }

  async complete(_messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    providerCalls.push({ provider: this.options.provider, model: this.options.model, options });
    if (this.options.provider === 'anthropic') throw rateLimit();
    return { content: 'ok', model: options?.model ?? this.options.model, stopReason: 'end_turn' };
  }
}

class FakeCoreToolExecutor {
  constructor(readonly options: unknown) {}
  getContext(): unknown {
    return (this.options as { context?: unknown }).context;
  }
  withContext(context: unknown): FakeCoreToolExecutor {
    return new FakeCoreToolExecutor({ ...(this.options as Record<string, unknown>), context });
  }
}

class FakeAgentRunner {
  constructor(private readonly options: { architecture: { model?: string }; llm: LLMProvider }) {}

  async *execute(): AsyncGenerator<unknown> {
    for await (const _chunk of this.options.llm.stream([], { model: this.options.architecture.model })) {
      void _chunk;
    }
    yield { type: 'done', content: 'ok', toolCalls: [] };
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  providerCalls.length = 0;
});

describe('runHeadless fallback integration', () => {
  it('falls back on a forced primary 429 and calls the Codex provider with its own model', async () => {
    vi.doMock('@dongkseo/core', async (importActual) => {
      const actual = await importActual<typeof import('@dongkseo/core')>();
      return {
        ...actual,
        AgentRunner: FakeAgentRunner,
        CoreToolExecutor: FakeCoreToolExecutor,
        PiAiProvider: FakePiAiProvider,
        InMemoryBudgetTracker: class {},
        createBudgetMiddleware: () => ({}),
        listAvailableModels: (options?: { credentialedOnly?: boolean }) =>
          options?.credentialedOnly === false
            ? ['anthropic/claude-sonnet-4-5', 'openai-codex/gpt-5.5']
            : ['anthropic/claude-sonnet-4-5'],
        isSandboxSupported: () => true,
        createSandboxProvider: () => ({ acquire: async () => ({ root: process.cwd() }) }),
        HostWorkspaceProvider: class {},
        drivePi: async ({ run }: { run: () => AsyncGenerator<unknown> }) => {
          for await (const _event of run()) {
            void _event;
          }
          return { status: 'completed' };
        },
      };
    });
    vi.doMock('@dongkseo/architectures', () => ({
      createReactArchitecture: (options: { model?: string }) => ({ model: options.model }),
    }));
    vi.doMock('@dongkseo/tools', () => ({
      sandboxToolDefinitions: () => [{ name: 'Bash' }],
    }));
    vi.doMock('@dongkseo/adapters', () => ({
      resolveCodexApiKey: async () => 'codex-key',
    }));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { runHeadless } = await import('../headless.js');
    await runHeadless([
      '-p',
      '--mode',
      'json',
      '--provider',
      'anthropic',
      '--model',
      'anthropic/claude-sonnet-4-5',
      'hello',
    ]);

    expect(providerCalls.map((call) => `${call.provider}/${call.model}:${call.options?.model}`)).toEqual([
      'anthropic/claude-sonnet-4-5:claude-sonnet-4-5',
      'openai-codex/gpt-5.5:gpt-5.5',
    ]);
  });
});
