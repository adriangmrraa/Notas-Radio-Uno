/**
 * Tests del slice PF-08: `imageModelService` — generación de imágenes
 * multi-modelo con provider seleccionable por tenant + fallback.
 *
 * Deterministas, mismo estilo que quoteFlyers/noteFactory: store en
 * memoria con el mismo filtro por tenant que la impl drizzle, `callModel`
 * FAKE que captura args y devuelve Buffers sintéticos (¡NUNCA HTTP real!),
 * `isEnabled`/`env`/`outputDir`/`newId`/`now` inyectados.
 *
 * Cubre el brief:
 *   - `isModelConfigured` por envKeys (todas presentes / falta una).
 *   - `resolveModelChain`: requested primero, tenant default segundo,
 *     configured-only, needsReferenceImages filtra text-only, sin
 *     duplicados, vacío si nada configured.
 *   - `generateImage`: gating off → feature_disabled; chain vacía →
 *     no_provider_configured; primer callModel OK → path + model correcto;
 *     primero falla → fallback al segundo (attempts registra ambos);
 *     todos fallan → all_providers_failed con attempts.
 *   - aislamiento por tenant en la query del store.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    generateImage,
    getImageModelDef,
    isModelConfigured,
    resolveModelChain,
    IMAGE_MODEL_REGISTRY,
    AllImageProvidersFailedError,
    type CallImageModelArgs,
    type CallImageModelFn,
    type GenerateImageDeps,
    type ImageModelDef,
} from '../src/server/services/imageModelService';
import {
    createMemoryImageModelStore,
    seedImageModelTenant,
} from './helpers/memoryImageModelStore';

const T_A = 'tenant-a';
const T_B = 'tenant-b';
const NOW = new Date('2026-03-02T12:00:00Z');
const PNG_BYTES = Buffer.from('png-generado-fake');

const def = (id: string): ImageModelDef => {
    const found = getImageModelDef(id);
    if (!found) throw new Error(`fixture: def inexistente ${id}`);
    return found;
};

// ─── isModelConfigured ──────────────────────────────────────────────────────

describe('isModelConfigured', () => {
    it('true si TODAS las envKeys están presentes en env', () => {
        expect(isModelConfigured(def('gemini'), { GEMINI_API_KEY: 'k' })).toBe(true);
        expect(isModelConfigured(def('grok'), { XAI_API_KEY: 'x' })).toBe(true);
    });

    it('false si falta la key o está vacía', () => {
        expect(isModelConfigured(def('gemini'), {})).toBe(false);
        expect(isModelConfigured(def('gemini'), { GEMINI_API_KEY: '' })).toBe(false);
        expect(
            isModelConfigured(def('gemini'), { XAI_API_KEY: 'x' }),
        ).toBe(false);
    });
});

// ─── resolveModelChain (pura) ────────────────────────────────────────────────

describe('resolveModelChain', () => {
    const envAll = {
        GEMINI_API_KEY: 'g',
        XAI_API_KEY: 'x',
        OPENAI_API_KEY: 'o',
        IDEOGRAM_API_KEY: 'i',
        BFL_API_KEY: 'b',
        RECRAFT_API_KEY: 'r',
    };

    it('requested primero, tenant default segundo, resto del registry después', () => {
        const chain = resolveModelChain({
            requestedModel: 'flux',
            tenantModel: 'grok',
            env: envAll,
        });
        expect(chain.map((d) => d.id)).toEqual([
            'flux',     // requested
            'grok',     // tenant default
            'gemini',   // resto del registry en orden
            'gpt-image',
            'ideogram',
            'recraft',
        ]);
    });

    it('sin requested ni tenant: registry en orden, sólo configurados', () => {
        const chain = resolveModelChain({
            env: { XAI_API_KEY: 'x', RECRAFT_API_KEY: 'r' },
        });
        expect(chain.map((d) => d.id)).toEqual(['grok', 'recraft']);
    });

    it('requested o tenant NO configurado no entra a la chain', () => {
        const chain = resolveModelChain({
            requestedModel: 'ideogram', // sin IDEOGRAM_API_KEY
            tenantModel: 'gemini',
            env: { GEMINI_API_KEY: 'g' },
        });
        expect(chain.map((d) => d.id)).toEqual(['gemini']);
    });

    it('requested desconocido (no está en el registry) se ignora', () => {
        const chain = resolveModelChain({
            requestedModel: 'dall-e-99',
            env: { GEMINI_API_KEY: 'g' },
        });
        expect(chain.map((d) => d.id)).toEqual(['gemini']);
    });

    it('needsReferenceImages filtra text-only en TODOS los pasos', () => {
        const chain = resolveModelChain({
            requestedModel: 'grok',   // text-only: salteado aunque pedido
            tenantModel: 'flux',      // text-only: salteado aunque default
            env: envAll,
            needsReferenceImages: true,
        });
        // Sólo gemini soporta reference images.
        expect(chain.map((d) => d.id)).toEqual(['gemini']);
    });

    it('needsReferenceImages con sólo text-only configurados → chain vacía', () => {
        const chain = resolveModelChain({
            env: { XAI_API_KEY: 'x', RECRAFT_API_KEY: 'r' },
            needsReferenceImages: true,
        });
        expect(chain).toEqual([]);
    });

    it('sin duplicados cuando requested == tenant', () => {
        const chain = resolveModelChain({
            requestedModel: 'grok',
            tenantModel: 'grok',
            env: { XAI_API_KEY: 'x', GEMINI_API_KEY: 'g' },
        });
        expect(chain.map((d) => d.id)).toEqual(['grok', 'gemini']);
    });

    it('nada configurado → chain vacía', () => {
        expect(
            resolveModelChain({ requestedModel: 'gemini', env: {} }),
        ).toEqual([]);
    });
});

// ─── generateImage (flujo completo con deps fake) ────────────────────────────

describe('generateImage', () => {
    let outputDir: string;
    let seq: number;

    interface ModelCall {
        def: ImageModelDef;
        args: CallImageModelArgs;
    }

    function makeDeps(
        store: ReturnType<typeof createMemoryImageModelStore>['store'],
        opts: {
            enabled?: boolean;
            env?: Record<string, string>;
            callModel?: CallImageModelFn;
        } = {},
    ) {
        const calls: ModelCall[] = [];
        const callModel: CallImageModelFn =
            opts.callModel ??
            (async (d, args) => {
                calls.push({ def: d, args });
                return PNG_BYTES;
            });
        const deps: GenerateImageDeps = {
            store,
            callModel,
            isEnabled: async () => opts.enabled ?? true,
            env: opts.env ?? {},
            outputDir,
            newId: () => `img-${++seq}`,
            now: () => NOW,
        };
        return { deps, calls };
    }

    beforeEach(() => {
        outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf08-'));
        seq = 0;
    });

    afterEach(() => {
        fs.rmSync(outputDir, { recursive: true, force: true });
    });

    it('feature off → feature_disabled 403, sin llamar callModel ni el store', async () => {
        const { store } = createMemoryImageModelStore();
        const { deps, calls } = makeDeps(store, {
            enabled: false,
            env: { GEMINI_API_KEY: 'g' },
        });

        await expect(
            generateImage({ tenantId: T_A, prompt: 'fondo' }, deps),
        ).rejects.toMatchObject({ statusCode: 403, code: 'feature_disabled' });
        expect(calls).toHaveLength(0);
    });

    it('chain vacía (ninguna API key) → no_provider_configured 503', async () => {
        const { store } = createMemoryImageModelStore();
        const { deps, calls } = makeDeps(store, { env: {} });

        await expect(
            generateImage({ tenantId: T_A, prompt: 'fondo' }, deps),
        ).rejects.toMatchObject({
            statusCode: 503,
            code: 'no_provider_configured',
        });
        expect(calls).toHaveLength(0);
    });

    it('reference images + sólo text-only configurados → no_provider_configured', async () => {
        const { store } = createMemoryImageModelStore();
        const { deps, calls } = makeDeps(store, {
            env: { XAI_API_KEY: 'x' },
        });

        await expect(
            generateImage(
                {
                    tenantId: T_A,
                    prompt: 'fondo',
                    referenceImages: [Buffer.from('ref')],
                },
                deps,
            ),
        ).rejects.toMatchObject({ code: 'no_provider_configured' });
        expect(calls).toHaveLength(0);
    });

    it('éxito en el primer modelo: escribe output/<id>.png y devuelve path+model', async () => {
        const { store } = createMemoryImageModelStore();
        const { deps, calls } = makeDeps(store, {
            env: { GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' },
        });

        const result = await generateImage(
            { tenantId: T_A, prompt: 'un fondo editorial' },
            deps,
        );

        const expectedPath = path.join(outputDir, 'img-1.png');
        expect(result.path).toBe(expectedPath);
        expect(result.model).toBe('gemini'); // primero del registry
        expect(result.generatedAt).toBe(NOW);
        expect(result.attempts).toEqual([{ model: 'gemini', ok: true }]);
        // El archivo existe con los bytes que devolvió el provider.
        expect(fs.readFileSync(expectedPath)).toEqual(PNG_BYTES);
        // Fallback no se intentó.
        expect(calls).toHaveLength(1);
        // apiKey y model resueltos del def + env.
        expect(calls[0].args.apiKey).toBe('g');
        expect(calls[0].args.model).toBe('gemini-3.1-flash-image-preview');
    });

    it('requested model gana sobre tenant default y registry', async () => {
        const { store, state } = createMemoryImageModelStore();
        seedImageModelTenant(state, { tenantId: T_A, imageModel: 'gemini' });
        const { deps, calls } = makeDeps(store, {
            env: { GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' },
        });

        const result = await generateImage(
            { tenantId: T_A, prompt: 'fondo', model: 'grok' },
            deps,
        );

        expect(result.model).toBe('grok');
        expect(calls[0].def.id).toBe('grok');
        expect(calls[0].args.apiKey).toBe('x');
    });

    it('tenant default se usa cuando no hay requested', async () => {
        const { store, state } = createMemoryImageModelStore();
        seedImageModelTenant(state, { tenantId: T_A, imageModel: 'grok' });
        const { deps, calls } = makeDeps(store, {
            env: { GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' },
        });

        const result = await generateImage(
            { tenantId: T_A, prompt: 'fondo' },
            deps,
        );

        expect(result.model).toBe('grok');
        expect(calls[0].def.id).toBe('grok');
    });

    it('tenant default sin API key se saltea → cae al registry configurado', async () => {
        const { store, state } = createMemoryImageModelStore();
        // El tenant prefiere grok pero no hay XAI_API_KEY.
        seedImageModelTenant(state, { tenantId: T_A, imageModel: 'grok' });
        const { deps } = makeDeps(store, { env: { GEMINI_API_KEY: 'g' } });

        const result = await generateImage(
            { tenantId: T_A, prompt: 'fondo' },
            deps,
        );

        expect(result.model).toBe('gemini');
    });

    it('modelEnvKey overridea el defaultModel que recibe callModel', async () => {
        const { store } = createMemoryImageModelStore();
        const { deps, calls } = makeDeps(store, {
            env: { GEMINI_API_KEY: 'g', GEMINI_IMAGE_MODEL: 'gemini-x' },
        });

        await generateImage({ tenantId: T_A, prompt: 'fondo' }, deps);

        expect(calls[0].args.model).toBe('gemini-x');
    });

    it('reference images se pasan a callModel en modelos que las soportan', async () => {
        const { store } = createMemoryImageModelStore();
        const refs = [Buffer.from('foto-ref-1'), Buffer.from('foto-ref-2')];
        const { deps, calls } = makeDeps(store, {
            env: { GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' },
        });

        const result = await generateImage(
            { tenantId: T_A, prompt: 'fondo', referenceImages: refs },
            deps,
        );

        // Con refs la chain sólo contiene gemini (único que las soporta).
        expect(result.model).toBe('gemini');
        expect(calls).toHaveLength(1);
        expect(calls[0].args.referenceImages).toBe(refs);
    });

    it('primer modelo falla → fallback al segundo, attempts registra ambos', async () => {
        const { store } = createMemoryImageModelStore();
        const calls: ModelCall[] = [];
        const callModel: CallImageModelFn = async (d, args) => {
            calls.push({ def: d, args });
            if (d.id === 'gemini') throw new Error('gemini 500 exploded');
            return PNG_BYTES;
        };
        const { deps } = makeDeps(store, {
            env: { GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' },
            callModel,
        });

        const result = await generateImage(
            { tenantId: T_A, prompt: 'fondo' },
            deps,
        );

        expect(result.model).toBe('grok');
        expect(result.attempts).toEqual([
            { model: 'gemini', ok: false, error: 'gemini 500 exploded' },
            { model: 'grok', ok: true },
        ]);
        expect(calls.map((c) => c.def.id)).toEqual(['gemini', 'grok']);
        expect(fs.readFileSync(result.path)).toEqual(PNG_BYTES);
    });

    it('todos fallan → all_providers_failed 502 con attempts completos', async () => {
        const { store } = createMemoryImageModelStore();
        const callModel: CallImageModelFn = async (d) => {
            throw new Error(`${d.id} cayo`);
        };
        const { deps } = makeDeps(store, {
            env: { GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' },
            callModel,
        });

        const err = await generateImage(
            { tenantId: T_A, prompt: 'fondo' },
            deps,
        ).then(
            () => {
                throw new Error('debió fallar');
            },
            (e: unknown) => e,
        );

        expect(err).toBeInstanceOf(AllImageProvidersFailedError);
        expect(err).toMatchObject({ statusCode: 502, code: 'all_providers_failed' });
        expect((err as AllImageProvidersFailedError).attempts).toEqual([
            { model: 'gemini', ok: false, error: 'gemini cayo' },
            { model: 'grok', ok: false, error: 'grok cayo' },
        ]);
        // Nada se escribió.
        expect(fs.readdirSync(outputDir)).toEqual([]);
    });

    it('aislamiento por tenant: el default de tenant-b no se lee desde tenant-a', async () => {
        const { store, state } = createMemoryImageModelStore();
        seedImageModelTenant(state, { tenantId: T_B, imageModel: 'grok' });
        const { deps, calls } = makeDeps(store, {
            env: { GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' },
        });

        const result = await generateImage(
            { tenantId: T_A, prompt: 'fondo' },
            deps,
        );

        // T_A no tiene default propio → cae al orden del registry (gemini),
        // nunca al 'grok' que tenant-b configuró.
        expect(result.model).toBe('gemini');
        expect(calls[0].def.id).toBe('gemini');
    });

    it('isEnabled recibe tenantId + key ai_image_models', async () => {
        const { store } = createMemoryImageModelStore();
        const seen: Array<{ tenantId: string; key: string }> = [];
        const { deps } = makeDeps(store, { env: { GEMINI_API_KEY: 'g' } });
        deps.isEnabled = async (tenantId, key) => {
            seen.push({ tenantId, key });
            return true;
        };

        await generateImage({ tenantId: T_A, prompt: 'fondo' }, deps);

        expect(seen).toEqual([{ tenantId: T_A, key: 'ai_image_models' }]);
    });
});
