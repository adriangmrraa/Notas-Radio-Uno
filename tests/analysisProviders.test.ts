/**
 * Tests del registry de proveedores de análisis (PE-01).
 *
 * `resolveAnalysisProvider` es la única fuente de verdad para "qué proveedor
 * resuelve cada proceso" (analysis / transcription / image). Los casos del
 * brief: defaults por preferencia, override por `ANALYSIS_PROVIDER_<P>`,
 * modelo por `ANALYSIS_MODEL_<P>` → `modelEnvKey` → default, y errores de
 * config explícita rota que se reportan en vez de caer en fallback silencioso.
 *
 * Toda la resolución depende de env vars → cada test corre con un set
 * controlado que se restaura al salir (ver `withEnv`).
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
    ANALYSIS_PROVIDERS,
    AnalysisProviderConfigError,
    AnalysisProviderUnavailableError,
    getAnalysisProvider,
    isAnalysisProviderConfigured,
    listAnalysisProviders,
    modelOverrideEnvKey,
    providerOverrideEnvKey,
    resolveAnalysisModel,
    resolveAnalysisProvider,
    resolveAnalysisProviders,
} from '../src/server/lib/analysisProviders';

const ENV_KEYS = [
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'ASSEMBLYAI_API_KEY',
    'ANALYSIS_PROVIDER_ANALYSIS',
    'ANALYSIS_PROVIDER_TRANSCRIPTION',
    'ANALYSIS_PROVIDER_IMAGE',
    'ANALYSIS_MODEL_ANALYSIS',
    'ANALYSIS_MODEL_TRANSCRIPTION',
    'ANALYSIS_MODEL_IMAGE',
    'GEMINI_ANALYSIS_MODEL',
    'OPENAI_ANALYSIS_MODEL',
    'ASSEMBLYAI_SPEECH_MODEL',
    'WHISPER_MODEL',
] as const;

const snapshot = new Map<string, string | undefined>();
for (const key of ENV_KEYS) snapshot.set(key, process.env[key]);

afterEach(() => {
    for (const key of ENV_KEYS) {
        const value = snapshot.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

function clearEnv(): void {
    for (const key of ENV_KEYS) delete process.env[key];
}

describe('resolveAnalysisProvider — defaults por preferencia', () => {
    it('analysis → gemini cuando GEMINI_API_KEY está seteada', () => {
        clearEnv();
        process.env.GEMINI_API_KEY = 'k';
        expect(resolveAnalysisProvider('analysis').id).toBe('gemini');
    });

    it('analysis → openai-vision cuando sólo hay OPENAI_API_KEY', () => {
        clearEnv();
        process.env.OPENAI_API_KEY = 'k';
        expect(resolveAnalysisProvider('analysis').id).toBe('openai-vision');
    });

    it('analysis prefiere gemini sobre openai-vision con ambas keys', () => {
        clearEnv();
        process.env.GEMINI_API_KEY = 'k';
        process.env.OPENAI_API_KEY = 'k';
        expect(resolveAnalysisProvider('analysis').id).toBe('gemini');
    });

    it('transcription → assemblyai primero, whisper como fallback', () => {
        clearEnv();
        process.env.ASSEMBLYAI_API_KEY = 'a';
        process.env.OPENAI_API_KEY = 'o';
        expect(resolveAnalysisProvider('transcription').id).toBe('assemblyai');

        delete process.env.ASSEMBLYAI_API_KEY;
        expect(resolveAnalysisProvider('transcription').id).toBe('whisper');
    });

    it('image → gemini (mismo default que analysis)', () => {
        clearEnv();
        process.env.GEMINI_API_KEY = 'k';
        expect(resolveAnalysisProvider('image').id).toBe('gemini');
        expect(resolveAnalysisProvider('image').supports.imageInput).toBe(true);
    });
});

describe('resolveAnalysisProvider — override por env', () => {
    it('ANALYSIS_PROVIDER_TRANSCRIPTION=whisper fuerza whisper aunque haya assemblyai', () => {
        clearEnv();
        process.env.ASSEMBLYAI_API_KEY = 'a';
        process.env.OPENAI_API_KEY = 'o';
        process.env.ANALYSIS_PROVIDER_TRANSCRIPTION = 'whisper';
        const resolved = resolveAnalysisProvider('transcription');
        expect(resolved.id).toBe('whisper');
        expect(resolved.forced).toBe(true);
    });

    it('override a proveedor que no sirve el proceso → AnalysisProviderConfigError', () => {
        clearEnv();
        process.env.ASSEMBLYAI_API_KEY = 'a';
        process.env.ANALYSIS_PROVIDER_ANALYSIS = 'assemblyai';
        expect(() => resolveAnalysisProvider('analysis')).toThrow(AnalysisProviderConfigError);
    });

    it('override a proveedor sin env keys → AnalysisProviderConfigError con la var que falta', () => {
        clearEnv();
        process.env.ANALYSIS_PROVIDER_ANALYSIS = 'gemini';
        expect(() => resolveAnalysisProvider('analysis')).toThrow(/GEMINI_API_KEY/);
    });

    it('override a proveedor desconocido → AnalysisProviderConfigError', () => {
        clearEnv();
        process.env.ANALYSIS_PROVIDER_IMAGE = 'midjourney';
        expect(() => resolveAnalysisProvider('image')).toThrow(AnalysisProviderConfigError);
    });
});

describe('resolveAnalysisProvider — sin proveedor configurado', () => {
    it('sin keys tira AnalysisProviderUnavailableError nombrando las env vars', () => {
        clearEnv();
        expect(() => resolveAnalysisProvider('transcription')).toThrow(
            AnalysisProviderUnavailableError,
        );
        expect(() => resolveAnalysisProvider('transcription')).toThrow(/ASSEMBLYAI_API_KEY/);
        expect(() => resolveAnalysisProvider('transcription')).toThrow(/OPENAI_API_KEY/);
    });
});

describe('modelo efectivo', () => {
    it('default del proveedor sin overrides', () => {
        clearEnv();
        process.env.GEMINI_API_KEY = 'k';
        expect(resolveAnalysisProvider('analysis').model).toBe('gemini-3.0-flash');
    });

    it('modelEnvKey del proveedor gana sobre default', () => {
        clearEnv();
        process.env.ASSEMBLYAI_API_KEY = 'a';
        process.env.ASSEMBLYAI_SPEECH_MODEL = 'universal-2';
        expect(resolveAnalysisProvider('transcription').model).toBe('universal-2');
    });

    it('ANALYSIS_MODEL_<PROCESO> gana sobre modelEnvKey y default', () => {
        clearEnv();
        process.env.GEMINI_API_KEY = 'k';
        process.env.GEMINI_ANALYSIS_MODEL = 'gemini-3.0-pro';
        process.env.ANALYSIS_MODEL_ANALYSIS = 'gemini-3.0-ultra';
        expect(resolveAnalysisProvider('analysis').model).toBe('gemini-3.0-ultra');
    });

    it('resolveAnalysisModel expone la misma cadena para un id puntual', () => {
        clearEnv();
        process.env.WHISPER_MODEL = 'whisper-large';
        expect(resolveAnalysisModel('transcription', 'whisper')).toBe('whisper-large');
        process.env.ANALYSIS_MODEL_TRANSCRIPTION = 'whisper-x';
        expect(resolveAnalysisModel('transcription', 'whisper')).toBe('whisper-x');
    });
});

describe('resolveAnalysisProviders — cadena de fallback', () => {
    it('devuelve los configurados en orden de preferencia', () => {
        clearEnv();
        process.env.ASSEMBLYAI_API_KEY = 'a';
        process.env.OPENAI_API_KEY = 'o';
        expect(resolveAnalysisProviders('transcription').map((p) => p.id)).toEqual([
            'assemblyai',
            'whisper',
        ]);
    });

    it('con override devuelve sólo el forzado', () => {
        clearEnv();
        process.env.ASSEMBLYAI_API_KEY = 'a';
        process.env.OPENAI_API_KEY = 'o';
        process.env.ANALYSIS_PROVIDER_TRANSCRIPTION = 'whisper';
        expect(resolveAnalysisProviders('transcription').map((p) => p.id)).toEqual(['whisper']);
    });

    it('sin nada configurado devuelve lista vacía (no tira)', () => {
        clearEnv();
        expect(resolveAnalysisProviders('image')).toEqual([]);
    });
});

describe('metadata del registry', () => {
    it('todo proveedor registrado declara al menos un proceso y un defaultModel', () => {
        for (const def of ANALYSIS_PROVIDERS) {
            expect(def.processes.length).toBeGreaterThan(0);
            expect(def.defaultModel).toBeTruthy();
            expect(def.envKeys.length).toBeGreaterThan(0);
        }
    });

    it('assemblyai declara diarización; gemini declara video+imagen', () => {
        expect(getAnalysisProvider('assemblyai')?.supports.diarization).toBe(true);
        expect(getAnalysisProvider('gemini')?.supports.videoInput).toBe(true);
        expect(getAnalysisProvider('gemini')?.supports.imageInput).toBe(true);
    });

    it('listAnalysisProviders filtra por proceso y marca disponibilidad', () => {
        clearEnv();
        process.env.OPENAI_API_KEY = 'k';
        const transcription = listAnalysisProviders('transcription');
        expect(transcription.map((p) => p.id)).toEqual(['assemblyai', 'whisper']);
        expect(transcription.find((p) => p.id === 'whisper')?.available).toBe(true);
        expect(transcription.find((p) => p.id === 'assemblyai')?.available).toBe(false);
    });

    it('las env keys de override siguen la convención documentada', () => {
        expect(providerOverrideEnvKey('analysis')).toBe('ANALYSIS_PROVIDER_ANALYSIS');
        expect(modelOverrideEnvKey('image')).toBe('ANALYSIS_MODEL_IMAGE');
    });

    it('isAnalysisProviderConfigured exige TODAS las env keys', () => {
        clearEnv();
        expect(isAnalysisProviderConfigured('gemini')).toBe(false);
        process.env.GEMINI_API_KEY = 'k';
        expect(isAnalysisProviderConfigured('gemini')).toBe(true);
        expect(isAnalysisProviderConfigured('inexistente')).toBe(false);
    });
});
