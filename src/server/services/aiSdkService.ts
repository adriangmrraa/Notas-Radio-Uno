/**
 * AI SDK Wrapper Service
 * 
 * Wraps Vercel AI SDK's generateText and streamText functions
 * with support for multiple providers (DeepSeek, Google Gemini, OpenAI).
 * 
 * Maintains backward compatibility with the existing chatCompletion interface.
 *
 * PI-03: cada llamada deja un evento en `ai_usage_events` cuando el caller
 * pasa `usageContext` ({ tenantId, transmissionId?, feature }) — éxito con
 * tokens + costo estimado, o `success=false` si el provider falla. El
 * registro NUNCA rompe la llamada (recordAiUsageEvent es best-effort).
 */

import { generateText as aiGenerateText, streamText as aiStreamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { AiUsageContext, ChatCompletionOptions, ChatCompletionResult } from '../../shared/types.js';
import { getProviderApiKey, type AIProvider } from './aiProviders.js';
import { recordAiUsageEvent, withAiUsageRecording } from './aiUsageService.js';
import { log } from '../lib/logger.js';

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
  },
  usageCtx?: AiUsageContext,
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

  return withAiUsageRecording({ provider, model, usageCtx }, async () => {
    const result = await aiGenerateText(generateOptions);
    return {
      value: { text: result.text, provider },
      usage: result.usage,
    };
  });
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
  },
  usageCtx?: AiUsageContext,
) {
  const model = getModelForProvider(provider);
  const client = createProviderClient(provider);
  const startedAt = Date.now();

  const stream = aiStreamText({
    model: client(model),
    system: options.system,
    prompt: options.prompt,
    temperature: options.temperature ?? 0.5,
    maxOutputTokens: options.maxTokens ?? 1000,
  });

  // El usage de un stream se conoce cuando termina: `stream.usage` resuelve
  // con LanguageModelUsage al final (o rechaza si el stream murió). El
  // registro es fire-and-forget — nunca bloquea ni rompe el stream.
  if (usageCtx) {
    const ctx = usageCtx;
    void stream.usage.then(
      (usage) =>
        recordAiUsageEvent({
          tenantId: ctx.tenantId,
          transmissionId: ctx.transmissionId ?? null,
          feature: ctx.feature,
          provider,
          model,
          usage,
          success: true,
          durationMs: Date.now() - startedAt,
        }),
      (err: unknown) =>
        recordAiUsageEvent({
          tenantId: ctx.tenantId,
          transmissionId: ctx.transmissionId ?? null,
          feature: ctx.feature,
          provider,
          model,
          success: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
        }),
    );
  }

  return stream;
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
      }, options.usageContext);

      // Map 'google' to 'gemini' for backward compatibility
      const mappedProvider = result.provider === 'google' ? 'gemini' : result.provider;

      return {
        text: result.text,
        provider: mappedProvider,
      };
    } catch (error) {
      log.warn('[AI] provider falló, probando el siguiente', { provider, err: error });
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
    usageContext?: AiUsageContext;
  }
): Promise<{ text: string; provider: AIProvider }> {
  return executeGenerate(provider, options, options.usageContext);
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
    usageContext?: AiUsageContext;
  }
): unknown {
  return executeStream(provider, options, options.usageContext);
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
    usageContext?: AiUsageContext;
  },
  preferredProvider?: AIProvider
): Promise<{ text: string; provider: AIProvider }> {
  const providers: AIProvider[] = preferredProvider 
    ? [preferredProvider, ...(['deepseek', 'google', 'openai'].filter(p => p !== preferredProvider) as AIProvider[])]
    : ['deepseek', 'google', 'openai'];

  for (const provider of providers) {
    try {
      return await executeGenerate(provider, options, options.usageContext);
    } catch (error) {
      log.warn('[AI] provider falló, probando el siguiente', { provider, err: error });
      continue;
    }
  }

  throw new Error('All AI providers failed');
}
