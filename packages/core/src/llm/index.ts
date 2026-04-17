/**
 * @nexora/core/llm — LLM Provider 구현체.
 *
 * Primary: OpenAIProvider + createProvider() — works with any OpenAI-compatible API.
 * Specialized: AnthropicProvider — for Anthropic-specific features (thinking, cache).
 * Resilience: FallbackLLMProvider — tries multiple providers in order.
 */

export { AnthropicProvider } from './anthropic.js';
export type { AnthropicProviderOptions } from './anthropic.js';

export { OpenAIProvider, createProvider, PROVIDER_PRESETS } from './openai.js';
export type { OpenAIProviderOptions, ProviderPreset } from './openai.js';

export { FallbackLLMProvider, classifyError } from './fallback.js';
export type { FallbackLLMProviderOptions, FallbackProviderEntry, ErrorClass } from './fallback.js';
