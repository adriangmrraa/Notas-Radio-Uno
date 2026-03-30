/**
 * AI SDK Wrapper Service
 * 
 * Wraps Vercel AI SDK's generateText and streamText functions
 * with support for multiple providers (DeepSeek, Google Gemini, OpenAI).
 * 
 * Maintains backward compatibility with the existing chatCompletion interface.
 */

import { generateText as aiGenerateText, streamText as aiStreamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { ChatCompletionOptions, ChatCompletionResult } from '../../shared/types.js';
import { getProviderApiKey, type AIProvider } from './aiProviders.js';

/**
 * Creates an AI SDK client for the specified provider
 */
function createProviderClient(provider: AIProvider) {
  const apiKey = getProviderApiKey(provider);
  if (!apiKey) {
    throw new Error(`API key not configured for provider: ${provider}`);
  }

  switch (provider) {
    case 'deepseek':
      // DeepSeek is OpenAI-compatible
      return createOpenAI({
        apiKey,
        baseURL: 'https://api.deepseek.com/v1',
      });
    
    case 'google':
      return createGoogleGenerativeAI({
        apiKey,
      });
    
    case 'openai':
      return createOpenAI({
        apiKey,
      });
    
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

/**
 * Get the model name for a provider
 */
function getModelForProvider(provider: AIProvider): string {
  switch (provider) {
    case 'deepseek':
      return 'deepseek-chat';
    case 'google':
      return 'gemini-2.0-flash';
    case 'openai':
      return 'gpt-4o-mini';
    default:
      return 'deepseek-chat';
  }
}

/**
 * Execute generateText with a specific provider
 */
async function executeGenerate(
  provider: AIProvider,
  options: {
    system?: string;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
    json?: boolean;
  }
): Promise<{ text: string; provider: 'deepseek' | 'google' | 'openai' }> {
  const model = getModelForProvider(provider);
  const client = createProviderClient(provider);

  // Use 'any' to bypass strict typing since different providers have different option formats
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const generateOptions: any = {
    model: client(model),
    system: options.system,
    prompt: options.prompt,
    temperature: options.temperature ?? 0.5,
    maxOutputTokens: options.maxTokens ?? 1000,
  };

  // Add JSON mode support for compatible providers
  if (options.json) {
    if (provider === 'deepseek' || provider === 'openai') {
      generateOptions.responseFormat = { type: 'json_object' };
    } else if (provider === 'google') {
      generateOptions.providerOptions = { 
        responseMimeType: 'application/json' 
      };
    }
  }

  const result = await aiGenerateText(generateOptions);

  return {
    text: result.text,
    provider,
  };
}

/**
 * Execute streamText with a specific provider
 * Returns a stream for real-time text generation
 */
function executeStream(
  provider: AIProvider,
  options: {
    system?: string;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
  }
) {
  const model = getModelForProvider(provider);
  const client = createProviderClient(provider);

  return aiStreamText({
    model: client(model),
    system: options.system,
    prompt: options.prompt,
    temperature: options.temperature ?? 0.5,
    maxOutputTokens: options.maxTokens ?? 1000,
  });
}

// ─── Legacy Interface (Backward Compatibility) ───

/**
 * Unified AI completion interface
 * Maintains backward compatibility with existing chatCompletion
 * 
 * Tries providers in order: deepseek -> google -> openai
 */
export async function chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const providers: AIProvider[] = ['deepseek', 'google', 'openai'];
  
  for (const provider of providers) {
    try {
      const apiKey = getProviderApiKey(provider);
      if (!apiKey) continue;

      const result = await executeGenerate(provider, {
        system: options.systemPrompt,
        prompt: options.userPrompt,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        json: options.jsonMode,
      });

      // Map 'google' to 'gemini' for backward compatibility
      const mappedProvider = result.provider === 'google' ? 'gemini' : result.provider;

      return {
        text: result.text,
        provider: mappedProvider,
      };
    } catch (error) {
      console.error(`[AI] ${provider} error:`, error);
      // Try next provider
      continue;
    }
  }

  throw new Error(
    'Ningun proveedor de IA disponible. Configura al menos una API key (DEEPSEEK_API_KEY, GEMINI_API_KEY, o OPENAI_API_KEY).'
  );
}

// ─── New AI SDK Interface ───

/**
 * Generate text using AI SDK (non-streaming)
 */
export async function generateText(
  provider: AIProvider,
  options: {
    system?: string;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
    json?: boolean;
  }
): Promise<{ text: string; provider: AIProvider }> {
  return executeGenerate(provider, options);
}

/**
 * Stream text using AI SDK
 * Returns a stream result for real-time text generation
 */
export function streamText(
  provider: AIProvider,
  options: {
    system?: string;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
  }
): unknown {
  return executeStream(provider, options);
}

/**
 * Generate text with automatic provider fallback
 */
export async function generateTextWithFallback(
  options: {
    system?: string;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
    json?: boolean;
  },
  preferredProvider?: AIProvider
): Promise<{ text: string; provider: AIProvider }> {
  const providers: AIProvider[] = preferredProvider 
    ? [preferredProvider, ...(['deepseek', 'google', 'openai'].filter(p => p !== preferredProvider) as AIProvider[])]
    : ['deepseek', 'google', 'openai'];

  for (const provider of providers) {
    try {
      return await executeGenerate(provider, options);
    } catch (error) {
      console.error(`[AI] ${provider} error:`, error);
      continue;
    }
  }

  throw new Error('All AI providers failed');
}
