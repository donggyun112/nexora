/**
 * CodexProvider — LLM provider using ChatGPT Codex Responses API.
 *
 * Uses the OAuth token from ~/.codex/auth.json (ChatGPT subscription).
 * Endpoint: https://chatgpt.com/backend-api/codex/responses
 * API format: OpenAI Responses API (NOT Chat Completions).
 */

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMChunk,
  LLMResponse,
  LLMContentBlock,
} from '@nexora/contracts';

export interface CodexProviderOptions {
  accessToken: string;
  defaultModel?: string;
  baseURL?: string;
}

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';

function extractAccountId(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT token');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  if (!accountId) throw new Error('No chatgpt_account_id in token');
  return accountId;
}

export class CodexProvider implements LLMProvider {
  private readonly token: string;
  private readonly accountId: string;
  private readonly defaultModel: string;
  private readonly baseURL: string;

  constructor(options: CodexProviderOptions) {
    this.token = options.accessToken;
    this.accountId = extractAccountId(this.token);
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL;
    this.baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  private get url(): string {
    return `${this.baseURL}/codex/responses`;
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.token}`,
      'chatgpt-account-id': this.accountId,
      'OpenAI-Beta': 'responses=experimental',
      'Content-Type': 'application/json',
      'accept': 'text/event-stream',
    };
  }

  private buildBody(
    messages: LLMMessage[],
    options?: LLMOptions,
  ): Record<string, unknown> {
    const input: Array<Record<string, unknown>> = [];

    let msgIdx = 0;
    const toFcId = (id: string): string => {
      if (!id) return `fc_${Date.now().toString(36)}`;
      if (id.startsWith('fc_')) return id;
      return `fc_${id.replace(/^call_/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 58)}`;
    };

    for (const msg of messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'user') {
        const text = typeof msg.content === 'string'
          ? msg.content
          : (msg.content as LLMContentBlock[]).filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
        // Responses API: user content must be array of input_text
        input.push({ role: 'user', content: [{ type: 'input_text', text }] });

      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          if (msg.content) {
            input.push({
              type: 'message', role: 'assistant', status: 'completed',
              id: `msg_${msgIdx}`,
              content: [{ type: 'output_text', text: msg.content, annotations: [] }],
            });
          }
        } else {
          const blocks = msg.content as LLMContentBlock[];
          const textParts = blocks.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
          const toolCalls = blocks.filter(b => b.type === 'tool_call') as Array<{ type: 'tool_call'; id: string; name: string; arguments: unknown }>;

          if (textParts) {
            input.push({
              type: 'message', role: 'assistant', status: 'completed',
              id: `msg_${msgIdx}`,
              content: [{ type: 'output_text', text: textParts, annotations: [] }],
            });
          }
          for (const tc of toolCalls) {
            const callId = toFcId(tc.id);
            input.push({
              type: 'function_call',
              id: callId,
              call_id: callId,
              name: tc.name,
              arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
            });
          }
        }

      } else if (msg.role === 'tool_result') {
        if (Array.isArray(msg.content)) {
          for (const block of msg.content as LLMContentBlock[]) {
            if (block.type === 'tool_result') {
              const tr = block as { id: string; content: string };
              input.push({
                type: 'function_call_output',
                call_id: toFcId(tr.id),
                output: tr.content,
              });
            }
          }
        }
      }
      msgIdx++;
    }

    const body: Record<string, unknown> = {
      model: options?.model ?? this.defaultModel,
      instructions: options?.systemPrompt ?? '',
      input,
      stream: true,
      store: false,
      text: { verbosity: options?.maxTokens && options.maxTokens <= 200 ? 'low' : 'medium' },
      include: ['reasoning.encrypted_content'],
    };

    if (options?.tools?.length) {
      body.tools = options.tools.map(t => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: null,
      }));
      body.tool_choice = 'auto';
      body.parallel_tool_calls = true;
    }

    return body;
  }

  async *stream(messages: LLMMessage[], options?: LLMOptions): AsyncGenerator<LLMChunk> {
    const MAX_RETRIES = 3;
    const body = JSON.stringify(this.buildBody(messages, options));
    let res: Response | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (options?.signal?.aborted) throw new Error('Request was aborted');
      try {
        res = await fetch(this.url, {
          method: 'POST',
          headers: this.buildHeaders(),
          body,
          signal: options?.signal,
        });
        if (res.ok) break;
        const errText = await res.text();
        if (attempt < MAX_RETRIES && (res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504)) {
          const delayMs = 1000 * 2 ** attempt;
          console.log(`[Codex] ${res.status} retry ${attempt + 1}/${MAX_RETRIES} in ${delayMs}ms`);
          await sleep(delayMs);
          continue;
        }
        throw Object.assign(new Error(`Codex API error ${res.status}: ${errText.slice(0, 200)}`), {
          name: res.status === 429 ? 'RateLimitError' : 'APIError',
        });
      } catch (err) {
        if (err instanceof Error && (err.name === 'RateLimitError' || err.name === 'APIError')) throw err;
        if (attempt < MAX_RETRIES) {
          console.log(`[Codex] network error retry ${attempt + 1}/${MAX_RETRIES}: ${(err as Error).message?.slice(0, 80)}`);
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw err;
      }
    }
    if (!res?.ok) throw new Error('Codex: failed after retries');

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buf = '';
    let accText = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx = buf.indexOf('\n\n');
        while (idx !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);

          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;

            try {
              const evt = JSON.parse(data) as Record<string, unknown>;
              const type = evt.type as string;

              // Text output
              if (type === 'response.output_text.delta') {
                const delta = (evt as { delta?: string }).delta ?? '';
                accText += delta;
                yield { type: 'text_delta', delta };
              }

              // Tool call
              if (type === 'response.function_call_arguments.start' || type === 'response.output_item.added') {
                const item = (evt as { item?: { type?: string; id?: string; name?: string; call_id?: string } }).item;
                if (item?.type === 'function_call' && item.name) {
                  yield { type: 'tool_call_start', id: item.call_id ?? item.id ?? '', name: item.name };
                }
              }
              if (type === 'response.function_call_arguments.delta') {
                const delta = (evt as { delta?: string }).delta ?? '';
                const callId = (evt as { call_id?: string; item_id?: string }).call_id ?? (evt as { item_id?: string }).item_id ?? '';
                yield { type: 'tool_call_delta', id: callId, delta };
              }

              // Done
              if (type === 'response.completed' || type === 'response.done') {
                yield { type: 'done', content: accText, stopReason: 'stop' };
                return;
              }

              // Error
              if (type === 'error' || type === 'response.failed') {
                const msg = (evt as { message?: string }).message
                  ?? (evt as { response?: { error?: { message?: string } } }).response?.error?.message
                  ?? 'Unknown error';
                throw new Error(`Codex stream error: ${msg}`);
              }
            } catch (e) {
              if (e instanceof Error && e.message.startsWith('Codex')) throw e;
              // JSON parse error — skip
            }
          }
          idx = buf.indexOf('\n\n');
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: 'done', content: accText, stopReason: 'stop' };
  }

  async complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    // Collect from stream
    let content = '';
    const toolCalls: { id: string; name: string; arguments: unknown }[] = [];
    const toolArgBuffers = new Map<string, { name: string; args: string }>();
    let model = options?.model ?? this.defaultModel;

    let lastToolCallId = '';
    for await (const chunk of this.stream(messages, options)) {
      if (chunk.type === 'text_delta') {
        content += chunk.delta;
      } else if (chunk.type === 'tool_call_start') {
        lastToolCallId = chunk.id;
        toolArgBuffers.set(chunk.id, { name: chunk.name, args: '' });
      } else if (chunk.type === 'tool_call_delta') {
        // Delta id may differ from start id (call_ vs fc_), use lastToolCallId as fallback
        const buf = toolArgBuffers.get(chunk.id) ?? toolArgBuffers.get(lastToolCallId);
        if (buf) buf.args += chunk.delta;
      } else if (chunk.type === 'done') {
        content = chunk.content;
      }
    }

    // Finalize tool calls
    for (const [id, buf] of toolArgBuffers) {
      let args: unknown;
      try { args = JSON.parse(buf.args); } catch { args = buf.args; }
      toolCalls.push({ id, name: buf.name, arguments: args });
    }

    return {
      content,
      model,
      stopReason: 'stop',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }
}
