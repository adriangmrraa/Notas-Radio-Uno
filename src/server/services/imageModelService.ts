/**
 * imageModelService — generación de imágenes multi-modelo con provider
 * seleccionable por tenant + fallback (PF-08, decisión D de la épica).
 *
 * Registry `IMAGE_MODEL_REGISTRY` con los 6 providers del brief: gemini y
 * grok portan los patrones HTTP que ya existen inline en
 * `pipelineService.generateAIBackground` (~líneas 1340/1433); gpt-image,
 * ideogram, flux y recraft quedan en el registry como contrato — su
 * `callImageModel` tira `model_not_implemented` hasta que lleguen sus API
 * keys (y de todos modos la chain los salta por no estar configurados).
 *
 * Resolución del modelo efectivo (`resolveModelChain`, pura):
 *   1) `requestedModel` del caller si está configurado,
 *   2) default del tenant (`tenants.config.imageModel`) si está configurado,
 *   3) el resto del registry en orden, filtrando configurados.
 *   `needsReferenceImages` filtra en TODOS los pasos los modelos que no
 *   soportan imágenes de referencia (text-only): pasarles el prompt sin
 *   las imágenes degradaría la generación en silencio — mejor salteados.
 *   Sin duplicados; puede quedar vacía.
 *
 * `generateImage` es el flujo completo: gating por feature flag
 * (`ai_image_models`, creator+) → default del tenant → chain → itera los
 * defs llamando `callModel` (inyectable — tests SIEMPRE pasan fake, nunca
 * HTTP real) → el primero que devuelve Buffer gana y se persiste en
 * `output/<uuid>.png`. Todos fallan ⇒ `all_providers_failed` con attempts.
 *
 * Deps inyectables: `{store, callModel, isEnabled, env, outputDir, newId,
 * now}` — mismo patrón que quoteFlyerService/noteFactoryService.
 *
 * Patrón del repo: `ImageModelStore` + `createDrizzleImageModelStore` +
 * memory store en tests — TODA query filtra por tenant_id.
 */
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

import { db, type Database } from '../db/index.js';
import { tenants } from '../db/schema/tenants.js';
import { AppError } from '../lib/errors.js';
import { isFeatureEnabled } from './tenantFeaturesService.js';
import { limiters } from './rateLimiter.js';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ImageModelDef {
    /** Identificador estable — el que reporta el resultado (`model`). */
    id: string;
    label: string;
    /** Env vars requeridas para considerarlo configurado (TODAS presentes). */
    envKeys: readonly string[];
    /** Modelo por defecto cuando no hay override por `modelEnvKey`. */
    defaultModel: string;
    /** Env propia del provider para override del modelo. */
    modelEnvKey?: string;
    /** true si el modelo acepta imágenes de referencia como input. */
    supportsReferenceImages: boolean;
}

/**
 * Registry de modelos de imagen — orden = preferencia de fallback cuando
 * ni el request ni el tenant eligen (gemini primero: es el único que soporta
 * reference images, y después el orden del brief).
 */
export const IMAGE_MODEL_REGISTRY: readonly ImageModelDef[] = [
    {
        id: 'gemini',
        label: 'Google Gemini (Nano Banana 2)',
        envKeys: ['GEMINI_API_KEY'],
        defaultModel: 'gemini-3.1-flash-image-preview',
        modelEnvKey: 'GEMINI_IMAGE_MODEL',
        supportsReferenceImages: true,
    },
    {
        id: 'grok',
        label: 'xAI Grok Image',
        envKeys: ['XAI_API_KEY'],
        defaultModel: 'grok-2-image',
        modelEnvKey: 'XAI_IMAGE_MODEL',
        supportsReferenceImages: false,
    },
    {
        id: 'gpt-image',
        label: 'OpenAI GPT Image',
        envKeys: ['OPENAI_API_KEY'],
        defaultModel: 'gpt-image-1',
        modelEnvKey: 'OPENAI_IMAGE_MODEL',
        supportsReferenceImages: false,
    },
    {
        id: 'ideogram',
        label: 'Ideogram',
        envKeys: ['IDEOGRAM_API_KEY'],
        defaultModel: 'ideogram-v3',
        modelEnvKey: 'IDEOGRAM_IMAGE_MODEL',
        supportsReferenceImages: false,
    },
    {
        id: 'flux',
        label: 'Black Forest Labs FLUX',
        envKeys: ['BFL_API_KEY'],
        defaultModel: 'flux-1.1-pro',
        modelEnvKey: 'BFL_IMAGE_MODEL',
        supportsReferenceImages: false,
    },
    {
        id: 'recraft',
        label: 'Recraft',
        envKeys: ['RECRAFT_API_KEY'],
        defaultModel: 'recraft-v3',
        modelEnvKey: 'RECRAFT_IMAGE_MODEL',
        supportsReferenceImages: false,
    },
] as const;

/** Feature flag de plan gating — entrada aditiva en `FEATURE_CATALOG`. */
export const IMAGE_MODELS_FEATURE_KEY = 'ai_image_models';

/** `process.env` o un literal de tests — `Record<string, string|undefined>`. */
export type EnvLike = Record<string, string | undefined>;

export function getImageModelDef(id: string): ImageModelDef | undefined {
    return IMAGE_MODEL_REGISTRY.find((d) => d.id === id);
}

/** true si TODAS las env vars requeridas del modelo están seteadas. */
export function isModelConfigured(def: ImageModelDef, env: EnvLike): boolean {
    return def.envKeys.every((key) => Boolean(env[key]));
}

export interface ResolveModelChainInput {
    /** Modelo pedido explícitamente por el caller (gana sobre todo). */
    requestedModel?: string | null;
    /** Default del tenant (`tenants.config.imageModel`). */
    tenantModel?: string | null;
    env: EnvLike;
    /** true ⇒ sólo modelos que aceptan imágenes de referencia. */
    needsReferenceImages?: boolean;
}

/**
 * Cadena ordenada de candidatos a probar, sin duplicados:
 *   1) `requestedModel` si existe en el registry y está configurado,
 *   2) `tenantModel` idem,
 *   3) el resto del registry en orden.
 * Con `needsReferenceImages` el filtro `supportsReferenceImages` aplica en
 * los TRES pasos: un modelo text-only no puede honrar las imágenes de
 * referencia del request — silenciarlas sería peor que salteároslo.
 */
export function resolveModelChain(
    input: ResolveModelChainInput,
): ImageModelDef[] {
    const needsRefs = input.needsReferenceImages ?? false;
    const usable = (def: ImageModelDef): boolean =>
        isModelConfigured(def, input.env) &&
        (!needsRefs || def.supportsReferenceImages);

    const chain: ImageModelDef[] = [];
    const push = (id: string | null | undefined): void => {
        if (!id) return;
        const def = getImageModelDef(id);
        if (def && usable(def) && !chain.includes(def)) chain.push(def);
    };

    push(input.requestedModel);
    push(input.tenantModel);
    for (const def of IMAGE_MODEL_REGISTRY) push(def.id);
    return chain;
}

// ---------------------------------------------------------------------------
// callImageModel — HTTP real SOLO para gemini y grok (patrones portados de
// pipelineService); el resto de ids ⇒ `model_not_implemented`.
// ---------------------------------------------------------------------------

export interface CallImageModelArgs {
    prompt: string;
    /** API key resuelta de `env[def.envKeys[0]]` por el caller. */
    apiKey: string;
    /** Modelo efectivo: `env[def.modelEnvKey]` ?? `def.defaultModel`. */
    model: string;
    /** Imágenes de referencia (bytes) — sólo providers que las soportan. */
    referenceImages?: Buffer[];
}

/** Devuelve los bytes de la imagen generada; tira Error si el provider falla. */
export type CallImageModelFn = (
    def: ImageModelDef,
    args: CallImageModelArgs,
) => Promise<Buffer>;

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Mime type por magic bytes — Gemini acepta png/jpeg/webp como inlineData. */
function sniffImageMimeType(buf: Buffer): string {
    if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (
        buf.length >= 12 &&
        buf.toString('ascii', 0, 4) === 'RIFF' &&
        buf.toString('ascii', 8, 12) === 'WEBP'
    ) {
        return 'image/webp';
    }
    return 'image/png';
}

/**
 * Gemini `generateContent` con responseModalities IMAGE — patrón portado de
 * `pipelineService.tryGeminiImageModel`: reference images como inlineData
 * base64 antes del prompt, imagen extraída del primer part con `inlineData`.
 * A diferencia del viejo (que devolvía null), acá los fallos TIRAN — el
 * caller registra el intento y sigue con el próximo def de la chain.
 */
async function callGeminiImage(args: CallImageModelArgs): Promise<Buffer> {
    await limiters.imageGen.acquire();

    const url = `${GEMINI_API}/${args.model}:generateContent?key=${args.apiKey}`;

    const parts: Array<
        { inlineData: { mimeType: string; data: string } } | { text: string }
    > = [];
    for (const img of args.referenceImages ?? []) {
        parts.push({
            inlineData: { mimeType: sniffImageMimeType(img), data: img.toString('base64') },
        });
    }
    parts.push({ text: args.prompt });

    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
        },
    };

    const response = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 90000,
    });

    const candidate = response.data?.candidates?.[0];
    const candidateParts = (candidate?.content?.parts ?? []) as Array<{
        inlineData?: { data?: string };
    }>;
    const imagePart = candidateParts.find((p) => p.inlineData?.data);
    if (!imagePart?.inlineData?.data) {
        throw new Error('gemini: respuesta sin imagen');
    }
    return Buffer.from(imagePart.inlineData.data, 'base64');
}

/**
 * xAI `images/generations` con `response_format: 'b64_json'` — patrón
 * portado de `pipelineService.generateWithGrok`. Grok es text-only: ignora
 * `referenceImages` (la chain ya lo filtra cuando hacen falta).
 */
async function callGrokImage(args: CallImageModelArgs): Promise<Buffer> {
    await limiters.imageGen.acquire();

    const response = await axios.post(
        'https://api.x.ai/v1/images/generations',
        {
            model: args.model,
            prompt: args.prompt,
            n: 1,
            response_format: 'b64_json',
        },
        {
            headers: {
                Authorization: `Bearer ${args.apiKey}`,
                'Content-Type': 'application/json',
            },
            timeout: 60000,
        },
    );

    const imageData = response.data?.data?.[0] as
        | { b64_json?: string }
        | undefined;
    if (!imageData?.b64_json) {
        throw new Error('grok: respuesta sin imagen');
    }
    return Buffer.from(imageData.b64_json, 'base64');
}

/**
 * Dispatcher real por `def.id`. Implementaciones de verdad SOLO para
 * `gemini` y `grok` (los patrones que ya existen en el pipeline viejo);
 * `gpt-image`/`ideogram`/`flux`/`recraft` tiran `model_not_implemented` —
 * sus defs quedan en el registry para cuando lleguen las API keys.
 */
export const callImageModel: CallImageModelFn = async (def, args) => {
    switch (def.id) {
        case 'gemini':
            return callGeminiImage(args);
        case 'grok':
            return callGrokImage(args);
        default:
            throw new AppError(
                `Modelo de imagen sin implementación HTTP: ${def.id}`,
                501,
                'model_not_implemented',
            );
    }
};

// ---------------------------------------------------------------------------
// Store — única query del slice: default del tenant en `tenants.config`.
// ---------------------------------------------------------------------------

export interface ImageModelStore {
    /** `tenants.config.imageModel` del tenant; null si no existe o no es string. */
    getTenantImageModel(tenantId: string): Promise<string | null>;
}

/** Implementación drizzle — la query filtra por `tenants.id` (tenant_id). */
export function createDrizzleImageModelStore(
    executor: Database = db,
): ImageModelStore {
    return {
        async getTenantImageModel(tenantId) {
            const [row] = await executor
                .select({ config: tenants.config })
                .from(tenants)
                .where(eq(tenants.id, tenantId))
                .limit(1);
            const config = row?.config as Record<string, unknown> | null | undefined;
            const value = config?.imageModel;
            return typeof value === 'string' && value.trim().length > 0
                ? value
                : null;
        },
    };
}

// ---------------------------------------------------------------------------
// generateImage — flujo completo
// ---------------------------------------------------------------------------

export interface GenerateImageInput {
    tenantId: string;
    prompt: string;
    /** Imágenes de referencia (bytes) — filtra la chain a modelos que las soportan. */
    referenceImages?: Buffer[];
    /** Modelo pedido explícitamente (gana sobre el default del tenant). */
    model?: string;
}

export interface GenerateImageDeps {
    store?: ImageModelStore;
    /** Default: dispatcher real por def.id — tests SIEMPRE inyectan fake. */
    callModel?: CallImageModelFn;
    /** Default: `isFeatureEnabled` real. */
    isEnabled?: (tenantId: string, key: string) => Promise<boolean>;
    env?: EnvLike;
    outputDir?: string;
    newId?: () => string;
    now?: () => Date;
}

export interface ImageAttempt {
    model: string;
    ok: boolean;
    /** Mensaje del fallo cuando ok=false. */
    error?: string;
}

export interface GenerateImageResult {
    /** Path absoluto del archivo escrito (`<outputDir>/<uuid>.png`). */
    path: string;
    /** `def.id` del modelo que efectivamente generó la imagen. */
    model: string;
    /** Registro de la cadena de fallback: cada intento en orden. */
    attempts: ImageAttempt[];
    generatedAt: Date;
}

/**
 * Todos los providers de la chain fallaron — lleva `attempts` para que el
 * caller/reporte sepa qué se probó y por qué falló cada uno.
 */
export class AllImageProvidersFailedError extends AppError {
    constructor(public readonly attempts: ImageAttempt[]) {
        super('Todos los modelos de imagen fallaron', 502, 'all_providers_failed');
        this.name = 'AllImageProvidersFailedError';
    }
}

const DEFAULT_OUTPUT_DIR = path.resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'output',
);

/**
 * Genera una imagen con el provider seleccionado + fallback:
 *   1. Plan gating: `ai_image_models` off ⇒ `feature_disabled` (403).
 *   2. Default del tenant: `tenants.config.imageModel` (store tenant-scoped).
 *   3. `resolveModelChain` vacía ⇒ `no_provider_configured` (503).
 *   4. Por cada def: `callModel` → éxito ⇒ escribe `<outputDir>/<uuid>.png`
 *      y devuelve `{path, model, attempts}`; fallo ⇒ registra y sigue.
 *   5. Todos fallaron ⇒ `all_providers_failed` (502) con `attempts`.
 */
export async function generateImage(
    input: GenerateImageInput,
    deps: GenerateImageDeps = {},
): Promise<GenerateImageResult> {
    const store = deps.store ?? createDrizzleImageModelStore();
    const callModel = deps.callModel ?? callImageModel;
    const isEnabled = deps.isEnabled ?? isFeatureEnabled;
    const env = deps.env ?? process.env;
    const outputDir = deps.outputDir ?? DEFAULT_OUTPUT_DIR;
    const newId = deps.newId ?? uuidv4;
    const now = deps.now ?? (() => new Date());

    // 1. Plan gating — el flag es por tenant, nunca global.
    if (!(await isEnabled(input.tenantId, IMAGE_MODELS_FEATURE_KEY))) {
        throw new AppError(
            'Los modelos de imagen IA no están habilitados para este tenant',
            403,
            'feature_disabled',
        );
    }

    // 2. Default del tenant (`tenants.config.imageModel`: 'gemini'|'grok'|…).
    const tenantModel = await store.getTenantImageModel(input.tenantId);

    // 3. Chain de candidatos configurados.
    const needsReferenceImages = (input.referenceImages?.length ?? 0) > 0;
    const chain = resolveModelChain({
        requestedModel: input.model,
        tenantModel,
        env,
        needsReferenceImages,
    });
    if (chain.length === 0) {
        throw new AppError(
            needsReferenceImages
                ? 'Ningún modelo configurado soporta imágenes de referencia'
                : 'No hay ningún modelo de imagen configurado',
            503,
            'no_provider_configured',
        );
    }

    // 4. Fallback real: el primer def que devuelve Buffer gana.
    const attempts: ImageAttempt[] = [];
    for (const def of chain) {
        const apiKey = env[def.envKeys[0]] as string;
        const model =
            (def.modelEnvKey ? env[def.modelEnvKey] : undefined) ??
            def.defaultModel;
        try {
            const buffer = await callModel(def, {
                prompt: input.prompt,
                apiKey,
                model,
                referenceImages: input.referenceImages,
            });
            fs.mkdirSync(outputDir, { recursive: true });
            const imagePath = path.join(outputDir, `${newId()}.png`);
            fs.writeFileSync(imagePath, buffer);
            attempts.push({ model: def.id, ok: true });
            return {
                path: imagePath,
                model: def.id,
                attempts,
                generatedAt: now(),
            };
        } catch (err) {
            attempts.push({
                model: def.id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // 5. Nada funcionó — se reporta la cadena completa de intentos.
    throw new AllImageProvidersFailedError(attempts);
}
