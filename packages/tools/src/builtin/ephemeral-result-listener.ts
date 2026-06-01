/**
 * Ephemeral result listener — host-side helper for `delegate({ waitForResult: 'async' })`.
 *
 * Application wiring: when an agent calls async delegate, the caller side
 * needs to know when the eventual `*.completed` / `*.failed` envelope arrives
 * and inject it back into its own conversation. Carriers (Discord, Web SSE,
 * Slack) each have their own conversation re-entry mechanism, so the inject
 * step lives in the application. This helper covers the parts that DON'T vary:
 *
 *   - subscribe to a topic pattern
 *   - filter by `metadata.replyTo === correlationId`
 *   - auto-unsubscribe after first match
 *   - timeout with explicit unsubscribe
 *
 * Returns a `dispose()` for early cancellation (e.g. if the caller conversation
 * itself dies before the result arrives).
 *
 * Why a helper, not a transport method: transports are durable / at-least-once
 * abstractions; ephemerality is a CALLER-side concern. Pushing this into the
 * transport API would force every transport (Redis Streams, durable queues)
 * to implement single-use semantics, which doesn't match their model.
 *
 * See: in7-marketing-poc/wiki/decisions/2026-06-01-delegation-primitives.md
 */

import type {
  EventTransport,
  MessageEnvelope,
  Subscription,
} from '@nexora/contracts';

export interface EphemeralResultListenerOptions {
  transport: EventTransport;
  /** Topic pattern to subscribe to. Same wildcards as `EventTransport.subscribe`. */
  topicPattern: string;
  /** Correlation id — must match `envelope.metadata.replyTo`. */
  correlationId: string;
  /** Handler invoked once when the matching envelope arrives. */
  onResult: (envelope: MessageEnvelope) => void | Promise<void>;
  /** Handler invoked when timeout elapses without a match. Optional. */
  onTimeout?: () => void;
  /** Timeout in ms. Default 1h (matches a typical thread idle TTL). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

export function createEphemeralResultListener(
  options: EphemeralResultListenerOptions,
): { dispose: () => void } {
  const {
    transport,
    topicPattern,
    correlationId,
    onResult,
    onTimeout,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  let settled = false;
  let subscription: Subscription | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finalize = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    subscription?.unsubscribe();
  };

  subscription = transport.subscribe(topicPattern, async (envelope) => {
    if (settled) return;
    if (envelope.metadata.replyTo !== correlationId) return;
    finalize();
    await onResult(envelope);
  });

  timer = setTimeout(() => {
    if (settled) return;
    finalize();
    onTimeout?.();
  }, timeoutMs);
  timer.unref?.();

  return {
    dispose: finalize,
  };
}
