/**
 * DiscordReactionController — status emoji reactions for Discord turns.
 *
 * Ports the reaction status pattern from auto-work-flow: react to the user's
 * triggering message with an emoji that reflects the current phase
 * (thinking / tool use / stall / done / error), debounced and serialized.
 *
 * SDK independence: this module does not import discord.js. Callers supply a
 * minimal `ReactableMessage` interface; `DiscordAdapter` adapts a real
 * discord.js Message into that shape.
 */

export interface ReactableMessage {
  /** Add an emoji reaction. Best-effort; failures are swallowed. */
  react: (emoji: string) => Promise<unknown>;
  /** Remove THIS bot's own reaction for the given emoji. Best-effort. */
  removeOwnReaction?: (emoji: string) => Promise<unknown>;
}

export interface StatusReactionController {
  /** Mark the turn as thinking (debounced, non-terminal). */
  setThinking(): void;
  /** Mark the turn as using a tool (debounced, non-terminal). */
  setTool(toolName?: string): void;
  /** Mark the turn as completed successfully (terminal, awaitable). */
  setDone(): Promise<void>;
  /** Mark the turn as errored (terminal, awaitable). */
  setError(): Promise<void>;
  /** Cancel all pending phases without writing a terminal state. */
  dispose(): void;
}

export interface StatusReactionOptions {
  /**
   * Initial marker emoji applied once per turn so users can spot the bot's
   * acknowledgment. Set to `null` to disable.
   * Default: 🤖
   */
  botEmoji?: string | null;
  /** Debounce for non-terminal phase changes. Default 700ms. */
  debounceMs?: number;
  /** Show a "stalled — still working" emoji after this delay. Default 10s. */
  stallWarnMs?: number;
  /** Show a stronger "no progress" emoji after this delay. Default 30s. */
  stallAlertMs?: number;
  /**
   * Override the emoji map. Missing keys fall back to `DEFAULT_EMOJI_MAP`.
   */
  emojis?: Partial<typeof DEFAULT_EMOJI_MAP>;
  /**
   * Map a tool name → emoji. Falls back to `emojis.tool` when not present.
   * Default: exec/read/grep → 💻.
   */
  toolEmojis?: Record<string, string>;
}

export const DEFAULT_EMOJI_MAP = {
  thinking: '\u{1F9E0}', // 🧠
  tool: '\u{1F6E0}️', // 🛠️
  code: '\u{1F4BB}', // 💻
  web: '\u{1F310}', // 🌐
  done: '✅', // ✅
  error: '❌', // ❌
  stallWarn: '⏳', // ⏳
  stallAlert: '⚠️', // ⚠️
} as const;

const DEFAULT_BOT_EMOJI = '\u{1F916}'; // 🤖
const DEFAULT_DEBOUNCE_MS = 700;
const DEFAULT_STALL_WARN_MS = 10_000;
const DEFAULT_STALL_ALERT_MS = 30_000;

const DEFAULT_TOOL_EMOJI_MAP: Record<string, string> = {
  exec: DEFAULT_EMOJI_MAP.code,
  read: DEFAULT_EMOJI_MAP.code,
  grep: DEFAULT_EMOJI_MAP.code,
  bash: DEFAULT_EMOJI_MAP.code,
  fetch: DEFAULT_EMOJI_MAP.web,
  web_search: DEFAULT_EMOJI_MAP.web,
};

/**
 * Create a per-turn reaction controller for a single Discord message.
 *
 * The controller serializes reaction edits onto an internal queue so the
 * order seen by users matches the order of `setXxx` calls, and so the final
 * terminal emoji (done/error) is always the last reaction applied.
 */
export function createStatusReactionController(
  message: ReactableMessage,
  options: StatusReactionOptions = {},
): StatusReactionController {
  const botEmoji = options.botEmoji === undefined ? DEFAULT_BOT_EMOJI : options.botEmoji;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const stallWarnMs = options.stallWarnMs ?? DEFAULT_STALL_WARN_MS;
  const stallAlertMs = options.stallAlertMs ?? DEFAULT_STALL_ALERT_MS;
  const emojis = { ...DEFAULT_EMOJI_MAP, ...(options.emojis ?? {}) };
  const toolEmojis = options.toolEmojis ?? DEFAULT_TOOL_EMOJI_MAP;

  let lastEmoji: string | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let stallWarnTimer: ReturnType<typeof setTimeout> | null = null;
  let stallAlertTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  let queue: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    const next = queue.then(fn, fn).catch(() => {});
    queue = next;
    return next;
  };

  const safeReact = async (emoji: string): Promise<void> => {
    try {
      await message.react(emoji);
    } catch {
      // Reactions are best-effort. Drop errors silently — permissions,
      // unknown-message races, rate limits, etc.
    }
  };

  const safeRemove = async (emoji: string): Promise<void> => {
    if (!message.removeOwnReaction) return;
    try {
      await message.removeOwnReaction(emoji);
    } catch {
      // ignore
    }
  };

  const clearStallTimers = () => {
    if (stallWarnTimer) {
      clearTimeout(stallWarnTimer);
      stallWarnTimer = null;
    }
    if (stallAlertTimer) {
      clearTimeout(stallAlertTimer);
      stallAlertTimer = null;
    }
  };

  const resetStallTimers = () => {
    clearStallTimers();
    if (disposed) return;
    stallWarnTimer = setTimeout(() => {
      enqueue(() => safeReact(emojis.stallWarn));
    }, stallWarnMs);
    stallAlertTimer = setTimeout(() => {
      enqueue(() => safeReact(emojis.stallAlert));
    }, stallAlertMs);
  };

  const clearAllReactions = async (): Promise<void> => {
    for (const emoji of Object.values(emojis)) {
      await safeRemove(emoji);
    }
  };

  let botEmojiApplied = false;
  const ensureBotEmojiOnce = async (): Promise<void> => {
    if (botEmojiApplied || botEmoji == null) return;
    botEmojiApplied = true;
    await safeReact(botEmoji);
  };

  const setPhase = (emoji: string) => {
    if (disposed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      enqueue(async () => {
        if (lastEmoji && lastEmoji !== emoji) {
          await safeRemove(lastEmoji);
        }
        await safeReact(emoji);
        lastEmoji = emoji;
      });
    }, debounceMs);
    resetStallTimers();
  };

  if (botEmoji != null) {
    enqueue(() => ensureBotEmojiOnce());
  }

  return {
    setThinking() {
      setPhase(emojis.thinking);
    },

    setTool(toolName?: string) {
      const emoji = (toolName && toolEmojis[toolName]) || emojis.tool;
      setPhase(emoji);
    },

    setDone() {
      disposed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      clearStallTimers();
      return enqueue(async () => {
        await clearAllReactions();
        await safeReact(emojis.done);
        lastEmoji = emojis.done;
      });
    },

    setError() {
      disposed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      clearStallTimers();
      return enqueue(async () => {
        await clearAllReactions();
        await safeReact(emojis.error);
        lastEmoji = emojis.error;
      });
    },

    dispose() {
      disposed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      clearStallTimers();
    },
  };
}
