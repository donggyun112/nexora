import { describe, expect, it, vi } from 'vitest';
import {
  createStatusReactionController,
  DEFAULT_EMOJI_MAP,
  type ReactableMessage,
} from '../discord-reactions.js';

function makeFakeMessage(): ReactableMessage & {
  react: ReturnType<typeof vi.fn>;
  removeOwnReaction: ReturnType<typeof vi.fn>;
} {
  return {
    react: vi.fn(async () => {}),
    removeOwnReaction: vi.fn(async () => {}),
  };
}

describe('createStatusReactionController', () => {
  it('applies bot marker emoji once on construction', async () => {
    const msg = makeFakeMessage();
    const ctrl = createStatusReactionController(msg);
    await ctrl.setDone();
    expect(msg.react).toHaveBeenCalledWith('\u{1F916}'); // 🤖
  });

  it('skips bot marker emoji when botEmoji=null', async () => {
    const msg = makeFakeMessage();
    const ctrl = createStatusReactionController(msg, { botEmoji: null });
    await ctrl.setDone();
    const reactedEmojis = msg.react.mock.calls.map((c) => c[0]);
    expect(reactedEmojis).not.toContain('\u{1F916}');
    expect(reactedEmojis).toContain(DEFAULT_EMOJI_MAP.done);
  });

  it('debounces setThinking and applies thinking emoji', async () => {
    vi.useFakeTimers();
    try {
      const msg = makeFakeMessage();
      const ctrl = createStatusReactionController(msg, { debounceMs: 100 });

      ctrl.setThinking();
      // Drain microtasks for the bot-emoji enqueue.
      await vi.advanceTimersByTimeAsync(0);
      expect(msg.react).not.toHaveBeenCalledWith(DEFAULT_EMOJI_MAP.thinking);

      await vi.advanceTimersByTimeAsync(100);
      // Allow queue drain.
      await vi.advanceTimersByTimeAsync(0);
      expect(msg.react).toHaveBeenCalledWith(DEFAULT_EMOJI_MAP.thinking);
    } finally {
      vi.useRealTimers();
    }
  });

  it('debounces setTool with tool-specific emoji', async () => {
    vi.useFakeTimers();
    try {
      const msg = makeFakeMessage();
      const ctrl = createStatusReactionController(msg, {
        debounceMs: 50,
        toolEmojis: { exec: '💻' },
      });

      ctrl.setTool('exec');
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(0);
      expect(msg.react).toHaveBeenCalledWith('💻');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to generic tool emoji for unknown tool names', async () => {
    vi.useFakeTimers();
    try {
      const msg = makeFakeMessage();
      const ctrl = createStatusReactionController(msg, { debounceMs: 50 });

      ctrl.setTool('unknown_tool');
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(0);
      expect(msg.react).toHaveBeenCalledWith(DEFAULT_EMOJI_MAP.tool);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes prior phase emoji when transitioning', async () => {
    vi.useFakeTimers();
    try {
      const msg = makeFakeMessage();
      const ctrl = createStatusReactionController(msg, { debounceMs: 10 });

      ctrl.setThinking();
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);

      ctrl.setTool('exec');
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);

      expect(msg.removeOwnReaction).toHaveBeenCalledWith(DEFAULT_EMOJI_MAP.thinking);
    } finally {
      vi.useRealTimers();
    }
  });

  it('setDone clears all reactions then applies ✅', async () => {
    const msg = makeFakeMessage();
    const ctrl = createStatusReactionController(msg, { botEmoji: null });

    await ctrl.setDone();

    // removeOwnReaction called for every emoji in the default map.
    const removedEmojis = msg.removeOwnReaction.mock.calls.map((c) => c[0]);
    for (const emoji of Object.values(DEFAULT_EMOJI_MAP)) {
      expect(removedEmojis).toContain(emoji);
    }
    // Final react was the done emoji.
    const reacted = msg.react.mock.calls.map((c) => c[0]);
    expect(reacted[reacted.length - 1]).toBe(DEFAULT_EMOJI_MAP.done);
  });

  it('setError clears all reactions then applies ❌', async () => {
    const msg = makeFakeMessage();
    const ctrl = createStatusReactionController(msg, { botEmoji: null });

    await ctrl.setError();

    const reacted = msg.react.mock.calls.map((c) => c[0]);
    expect(reacted[reacted.length - 1]).toBe(DEFAULT_EMOJI_MAP.error);
  });

  it('emits stall-warn emoji after stallWarnMs of inactivity', async () => {
    vi.useFakeTimers();
    try {
      const msg = makeFakeMessage();
      const ctrl = createStatusReactionController(msg, {
        debounceMs: 10,
        stallWarnMs: 200,
        stallAlertMs: 500,
        botEmoji: null,
      });

      ctrl.setThinking();
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(0);
      expect(msg.react).toHaveBeenCalledWith(DEFAULT_EMOJI_MAP.stallWarn);

      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(0);
      expect(msg.react).toHaveBeenCalledWith(DEFAULT_EMOJI_MAP.stallAlert);
    } finally {
      vi.useRealTimers();
    }
  });

  it('swallows react/remove errors silently', async () => {
    const msg: ReactableMessage = {
      react: vi.fn(async () => {
        throw new Error('boom');
      }),
      removeOwnReaction: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const ctrl = createStatusReactionController(msg, { botEmoji: null });
    // Should not throw.
    await expect(ctrl.setDone()).resolves.toBeUndefined();
  });

  it('dispose cancels pending phases and stall timers', async () => {
    vi.useFakeTimers();
    try {
      const msg = makeFakeMessage();
      const ctrl = createStatusReactionController(msg, {
        debounceMs: 100,
        stallWarnMs: 200,
        botEmoji: null,
      });

      ctrl.setThinking();
      ctrl.dispose();
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(0);

      // No reactions other than possible bot emoji (which we disabled).
      expect(msg.react).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('works without removeOwnReaction (degrades gracefully)', async () => {
    const msg: ReactableMessage = {
      react: vi.fn(async () => {}),
      // no removeOwnReaction
    };
    const ctrl = createStatusReactionController(msg, { botEmoji: null });
    await ctrl.setDone();
    expect(msg.react).toHaveBeenCalledWith(DEFAULT_EMOJI_MAP.done);
  });
});
