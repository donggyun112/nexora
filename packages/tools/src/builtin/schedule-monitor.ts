/**
 * schedule_monitor / cancel_monitor / list_monitors — agent-set recurring
 * self-wake. The agent arms "every N ms, wake me with this prompt to check
 * something". Rides the Phase 0 armTrigger spine via ctx.triggers (TriggerHost)
 * and the existing ctx.steerSelf / ctx.deliverResult wake channels.
 *
 * Guardrails: interval floored at 1000ms; a monitor MUST be bounded by max_fires
 * (default 10) and/or ttl_ms — no unbounded self-wake.
 */

import type { ToolContext, ToolDefinition, ToolResult } from '@dongkseo/contracts';
import { textResult, errorResult, createIntervalSource } from '@dongkseo/contracts';

const MIN_INTERVAL_MS = 1000;
const DEFAULT_MAX_FIRES = 10;

export function createScheduleMonitorTool(): ToolDefinition {
  return {
    name: 'schedule_monitor',
    description:
      'Arm a recurring self-wake: every N ms you are notified with a prompt to ' +
      're-check something (non-blocking). Bounded by max_fires (default 10) and/or ' +
      'ttl_ms. Use cancel_monitor to stop early, list_monitors to see active ones.',
    parameters: {
      type: 'object',
      required: ['prompt', 'every_ms'],
      properties: {
        prompt: { type: 'string', description: 'What to check / why you are being woken.' },
        every_ms: { type: 'number', description: 'Interval in ms (floored at 1000).' },
        max_fires: { type: 'number', description: 'Stop after this many wakes (default 10).' },
        ttl_ms: { type: 'number', description: 'Auto-stop after this many ms.' },
        label: { type: 'string', description: 'Optional human label for list_monitors.' },
      },
    } as unknown as Record<string, unknown>,
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    async execute(_callId: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      const host = ctx.triggers;
      if (!host) return errorResult('Monitors are not supported in this runtime.');
      const input = rawInput as { prompt?: unknown; every_ms?: unknown; max_fires?: unknown; ttl_ms?: unknown; label?: unknown };
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (!prompt) return errorResult('prompt is required.');
      const everyMs = Math.max(MIN_INTERVAL_MS, typeof input.every_ms === 'number' ? input.every_ms : 0);
      const maxFires = typeof input.max_fires === 'number' && input.max_fires > 0 ? Math.floor(input.max_fires) : undefined;
      const ttlMs = typeof input.ttl_ms === 'number' && input.ttl_ms > 0 ? input.ttl_ms : undefined;
      if (maxFires === undefined && ttlMs === undefined) {
        return errorResult('A monitor must be bounded: provide max_fires and/or ttl_ms.');
      }
      const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim() : prompt.slice(0, 40);
      const cap = maxFires ?? DEFAULT_MAX_FIRES;

      let fires = 0;
      const fire = () => {
        fires++;
        const msg = `[monitor "${label}"] tick #${fires}: ${prompt}`;
        if (ctx.steerSelf?.(msg)) return;
        if (ctx.deliverResult) {
          void ctx.deliverResult({ taskId: `monitor:${label}`, kind: 'monitor', label, content: msg, isError: false });
          return;
        }
        ctx.logger.warn('schedule_monitor.wake_dropped', { label, reason: 'no steerSelf and no deliverResult' });
      };

      const id = host.arm({
        label,
        source: createIntervalSource(everyMs),
        onFire: fire,
        recurring: true,
        maxFires: cap,
        ttlMs,
        fireOnArm: false,
        now: Date.now(),
      });

      const bound = [maxFires ? `${maxFires} fires` : null, ttlMs ? `${ttlMs}ms ttl` : null].filter(Boolean).join(', ');
      return textResult(`Armed monitor "${label}" (id ${id}) every ${everyMs}ms, bounded by ${bound}. Cancel with cancel_monitor.`);
    },
  };
}

export function createCancelMonitorTool(): ToolDefinition {
  return {
    name: 'cancel_monitor',
    description: 'Stop a recurring monitor by its id (from schedule_monitor / list_monitors).',
    parameters: {
      type: 'object',
      required: ['monitor_id'],
      properties: { monitor_id: { type: 'string', description: 'Monitor id.' } },
    } as unknown as Record<string, unknown>,
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: true,
    async execute(_callId: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      const host = ctx.triggers;
      if (!host) return errorResult('Monitors are not supported in this runtime.');
      const id = (rawInput as { monitor_id?: unknown }).monitor_id;
      if (typeof id !== 'string' || !id.trim()) return errorResult('monitor_id is required.');
      return host.cancel(id.trim())
        ? textResult(`Cancelled monitor ${id.trim()}.`)
        : errorResult(`No active monitor with id ${id.trim()}.`);
    },
  };
}

export function createListMonitorsTool(): ToolDefinition {
  return {
    name: 'list_monitors',
    description: 'List active recurring monitors you armed, with id / label / fire count.',
    parameters: { type: 'object', properties: {} } as unknown as Record<string, unknown>,
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    async execute(_callId: string, _rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      const host = ctx.triggers;
      if (!host) return errorResult('Monitors are not supported in this runtime.');
      const monitors = host.list();
      if (monitors.length === 0) return textResult('No active monitors.');
      return textResult(JSON.stringify(monitors));
    },
  };
}
