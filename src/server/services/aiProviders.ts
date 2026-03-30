/**
 * AI Provider Adapters
 * 
 * Configuration for multiple AI providers using Vercel AI SDK.
 * Each provider has API key handling and rate limiting integration.
 */

import { limiters } from "./rateLimiter.js";

export type AIProvider = 'deepseek' | 'google' | 'openai';

export interface ProviderConfig {
  name: string;
  apiKeyEnvVar: string;
  baseURL?: string;
  model: string;
  limiter: typeof limiters.deepseek;
  supportsStreaming: boolean;
  supportsJSON: boolean;
}

/**
 * Provider configurations
 */
export const PROVIDERS: Record<AIProvider, ProviderConfig> = {
  deepseek: {
    name: 'DeepSeek',
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    limiter: limiters.deepseek,
    supportsStreaming: true,
    supportsJSON: true,
  },
  google: {
    name: 'Google Gemini',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.0-flash',
    limiter: limiters.gemini,
    supportsStreaming: true,
    supportsJSON: true,
  },
  openai: {
    name: 'OpenAI',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    limiter: limiters.deepseek, // Reuse deepseek limiter as fallback
    supportsStreaming: true,
    supportsJSON: true,
  },
};

/**
 * Gets the API key for a provider from environment variables
 */
export function getProviderApiKey(provider: AIProvider): string | null {
  const config = PROVIDERS[provider];
  return process.env[config.apiKeyEnvVar] || null;
}

/**
 * Checks if a provider is configured (has API key)
 */
export function isProviderConfigured(provider: AIProvider): boolean {
  return getProviderApiKey(provider) !== null;
}

/**
 * Gets the list of available providers (that have API keys configured)
 */
export function getAvailableProviders(): AIProvider[] {
  return (Object.keys(PROVIDERS) as AIProvider[]).filter(isProviderConfigured);
}

/**
 * Gets provider configuration with validation
 */
export function getProviderConfig(provider: AIProvider): ProviderConfig | null {
  if (!isProviderConfigured(provider)) {
    console.warn(`[AI] Provider ${provider} not configured. Set ${PROVIDERS[provider].apiKeyEnvVar}`);
    return null;
  }
  return PROVIDERS[provider];
}
