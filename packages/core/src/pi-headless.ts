import type { AgentEvent } from '@dongkseo/contracts';

/**
 * Multica `pi` protocol_family adapter (headless, one-shot).
 *
 * Multica's daemon drives a `pi` backend by spawning a command as:
 *
 *   <cmd> -p --mode json --session <path> [--provider <p>] [--model <m>]
 *         [--append-system-prompt <s>] <...customArgs> "<prompt>"
 *
 * and parsing exactly one JSON event per line on stdout. This module
 * translates a Nexora `AgentRunner` event stream (`AgentEvent`) into that
 * wire format, so any Nexora-framework agent can be registered in Multica as
 * a `protocol_family: "pi"` custom runtime.
 *
 * Wire contract reference: server/pkg/agent/pi.go in the Multica repo. Keep
 * the event `type` strings and field names below in lockstep with the
 * `piStreamEvent` struct there.
 */

// ── Multica pi wire events (one JSON object per stdout line) ─────────────────

export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export type PiWireEvent =
  | { type: 'agent_start' }
  | {
      type: 'message_update';
      assistantMessageEvent: { type: 'text_delta' | 'thinking_delta'; delta: string };
    }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; result: unknown; isError: boolean }
  | { type: 'turn_end'; message: { usage: PiUsage; model?: string } }
  | { type: 'error'; message: string }
  | { type: 'auto_retry_end'; success: boolean; finalError?: string };

const ZERO_USAGE: PiUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

/** Per-turn mapping state — tracks streaming so `done` does not double-emit. */
export interface PiMapState {
  /** Whether any assistant text was streamed before the terminal `done`. */
  sawText: boolean;
  /** Whether a `turn_end` has already been emitted for this turn. */
  sawTurnEnd: boolean;
}

export function createPiMapState(): PiMapState {
  return { sawText: false, sawTurnEnd: false };
}

/**
 * Translate ONE Nexora `AgentEvent` into zero or more Multica pi wire events.
 * Pure (no I/O). `state` is mutated to track streaming so that a final `done`
 * carrying the full text does not re-emit content already streamed delta by
 * delta.
 */
export function agentEventToPiWire(ev: AgentEvent, state: PiMapState): PiWireEvent[] {
  switch (ev.type) {
    case 'text': {
      if (ev.text.length === 0) return [];
      state.sawText = true;
      return [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ev.text } }];
    }

    case 'thinking': {
      if (ev.content.length === 0) return [];
      return [
        { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: ev.content } },
      ];
    }

    case 'tool_call':
      return [{ type: 'tool_execution_start', toolCallId: ev.id, toolName: ev.name, args: ev.input }];

    case 'tool_result':
      return [{ type: 'tool_execution_end', toolCallId: ev.id, result: ev.result, isError: ev.isError }];

    case 'done': {
      const out: PiWireEvent[] = [];
      // If the architecture never streamed text deltas, surface the final
      // content as a single text_delta so Multica still records a body.
      if (!state.sawText && ev.content.length > 0) {
        out.push({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: ev.content },
        });
      }
      // Map the architecture's real token usage (when the provider reported it)
      // into the pi wire shape so Multica's ReportTaskUsage records actual cost.
      const usage: PiUsage = ev.usage
        ? {
            input: ev.usage.promptTokens ?? 0,
            output: ev.usage.completionTokens ?? 0,
            cacheRead: ev.usage.cachedTokens ?? 0,
            cacheWrite: 0,
            totalTokens: (ev.usage.promptTokens ?? 0) + (ev.usage.completionTokens ?? 0),
          }
        : { ...ZERO_USAGE };
      out.push({ type: 'turn_end', message: { usage, ...(ev.model ? { model: ev.model } : {}) } });
      state.sawTurnEnd = true;
      return out;
    }

    case 'error':
      return [{ type: 'error', message: ev.message }];

    case 'suspended':
      // Multica's pi protocol is autonomous: there is no mid-stream HITL, so a
      // suspend cannot be satisfied here. Report it as a failure.
      return [
        {
          type: 'error',
          message: `agent suspended awaiting external input (toolCallId=${ev.toolCallId})`,
        },
      ];

    // progress / artifact have no pi equivalent — drop silently.
    case 'progress':
    case 'artifact':
      return [];

    default:
      return [];
  }
}

// ── Driver ───────────────────────────────────────────────────────────────────

export interface DrivePiOptions {
  /** Starts the agent turn and yields Nexora `AgentEvent`s. */
  run: () => AsyncGenerator<AgentEvent>;
  /**
   * Emits one wire line (newline-free JSON). Defaults to `process.stdout`.
   * The driver appends the trailing newline.
   */
  write?: (line: string) => void;
  /** Optional second sink for the same lines (e.g. the `--session` file). */
  appendSession?: (line: string) => void;
}

export interface DrivePiResult {
  status: 'completed' | 'failed';
  error?: string;
}

/**
 * Drive a Nexora agent turn to completion, emitting the Multica pi event
 * stream. Always emits `agent_start` first and exactly one terminal
 * `turn_end` on success. Never throws for agent-level errors — they surface
 * as `error` wire events and a `failed` result, so the caller can map the
 * result to a process exit code.
 */
export async function drivePi(opts: DrivePiOptions): Promise<DrivePiResult> {
  const write = opts.write ?? ((line: string) => void process.stdout.write(line + '\n'));
  const emit = (ev: PiWireEvent): void => {
    const line = JSON.stringify(ev);
    write(line);
    opts.appendSession?.(line);
  };

  const state = createPiMapState();
  let result: DrivePiResult = { status: 'completed' };

  emit({ type: 'agent_start' });

  try {
    for await (const ev of opts.run()) {
      for (const wire of agentEventToPiWire(ev, state)) {
        emit(wire);
        if (wire.type === 'error') result = { status: 'failed', error: wire.message };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: 'error', message });
    return { status: 'failed', error: message };
  }

  // Defensive: a well-behaved AgentRunner ends with `done` (→ turn_end) or
  // `error`. If the stream completed cleanly without either, synthesize a
  // terminal turn_end so Multica does not treat the task as still running.
  if (result.status === 'completed' && !state.sawTurnEnd) {
    emit({ type: 'turn_end', message: { usage: { ...ZERO_USAGE } } });
  }

  return result;
}
