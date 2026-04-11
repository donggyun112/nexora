/**
 * @nexora/adapters — entry-point adapters.
 *
 * - HttpAdapter: REST API (node:http, no Express)
 * - DiscordAdapter: Discord bot (SDK-independent, pass your own discord.js Client)
 */

export { HttpAdapter } from './http.js';
export type { HttpAdapterOptions } from './http.js';

export { DiscordAdapter } from './discord.js';
export type {
  DiscordAdapterOptions,
  DiscordClientLike,
  DiscordMessageLike,
} from './discord.js';
