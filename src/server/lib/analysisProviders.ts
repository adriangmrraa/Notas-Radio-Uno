/**
 * analysisProviders — registry ÚNICO de proveedores del motor de análisis (PE-01).
 *
 * Es la sola fuente de verdad para "qué proveedor resuelve cada proceso":
 * el motor de análisis en vivo (PE-02), el sampler de frames (PE-03) y la
 * transcripción (`transcriptionService.transcribeAudio`) delegan acá — cada
 * uno conserva su propia lógica de negocio, pero la SELECCIÓN y la CONFIG
 * del proveedor viven sólo en este archivo.
 *
 * Procesos (`AnalysisProcess`):
 *   - analysis      → análisis multimodal del vivo (video + transcripción →
 *                     momentos, temas, citas). Default: Gemini (D-2 de la
 *                     tarjeta E). NO es Gemini Live API: el análisis corre
 *                     por segmentos ya grabados.
 *   - transcription → audio → utterances + diarización. Default: AssemblyAI
 *                     (diarización = timeline primario de identidad, D-2) con
 *                     Whisper como fallback.
 *   - image         → análisis visual de frames/segmentos del crudo. El
 *                     sampler de PE-03 lo consume. Default: Gemini.
 *
 * Config por proceso (env):
 *   - `ANALYSIS_PROVIDER_<PROCESO>` → fuerza el proveedor del proceso
 *     (ej. `ANALYSIS_PROVIDER_TRANSCRIPTION=whisper`). Si está seteada y el
 *     proveedor no sirve ese proceso o le falta su API key → error, nunca
 *     fallback silencioso: config explícita rota se reporta, no se disimula.
 *   - `ANALYSIS_MODEL_<PROCESO>` → override del modelo para el proceso
 *     (ej. `ANALYSIS_MODEL_ANALYSIS=gemini-3.0-pro`). Gana sobre el default
 *     del proveedor y sobre su `modelEnvKey` propio.
 *
 * El registry es PURO: no toca DB, no hace IO, no llama APIs. Disponibilidad
 * = presencia de las `envKeys` requeridas. Los per-tenant overrides llegan
 * como argumento del caller cuando haga falta — no se leen acá.
 */

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type AnalysisProcess = 'analysis' | 'transcription' | 'image';

export interface AnalysisProviderDef {
  /** Identificador estable — el que reportan los resultados (`provider`). */
  id: string;
  label: string;
  /** Procesos que este proveedor puede servir. */
  processes: readonly AnalysisProcess[];
  /** Env vars requeridas para considerarlo configurado (TODAS presentes). */
  envKeys: readonly string[];
  /** Modelo por defecto cuando no hay override. */
  defaultModel: string;
  /** Env propia del proveedor para override de modelo (pierde contra
   *  `ANALYSIS_MODEL_<PROCESO>`). */
  modelEnvKey?: string;
  supports: {
    /** Devuelve segmentos con speaker labels (AssemblyAI sí, Whisper no). */
    diarization?: boolean;
    /** Acepta video (segmentos MP4 del crudo) como input. */
    videoInput?: boolean;
    /** Acepta imágenes/frames como input. */
    imageInput?: boolean;
  };
}

export interface ResolvedAnalysisProvider extends AnalysisProviderDef {
  /** Modelo efectivo: `ANALYSIS_MODEL_<PROCESO>` → `modelEnvKey` → default. */
  model: string;
  /** true si llegó por `ANALYSIS_PROVIDER_<PROCESO>` (config explícita). */
  forced: boolean;
}

export class AnalysisProviderUnavailableError extends Error {
  constructor(
    public readonly proc: AnalysisProcess,
    public readonly reason: string,
  ) {
    super(`[analysis-providers] Sin proveedor para '${proc}': ${reason}`);
    this.name = 'AnalysisProviderUnavailableError';
  }
}

export class AnalysisProviderConfigError extends Error {
  constructor(
    public readonly proc: AnalysisProcess,
    public readonly providerId: string,
    public readonly reason: string,
  ) {
    super(`[analysis-providers] Override inválido para '${proc}' → '${providerId}': ${reason}`);
    this.name = 'AnalysisProviderConfigError';
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const GEMINI: AnalysisProviderDef = {
  id: 'gemini',
  label: 'Google Gemini (multimodal)',
  processes: ['analysis', 'image'],
  envKeys: ['GEMINI_API_KEY'],
  defaultModel: 'gemini-3.0-flash',
  modelEnvKey: 'GEMINI_ANALYSIS_MODEL',
  supports: { videoInput: true, imageInput: true },
};

const OPENAI_VISION: AnalysisProviderDef = {
  id: 'openai-vision',
  label: 'OpenAI GPT-4o (visión)',
  processes: ['analysis', 'image'],
  envKeys: ['OPENAI_API_KEY'],
  defaultModel: 'gpt-4o',
  modelEnvKey: 'OPENAI_ANALYSIS_MODEL',
  supports: { imageInput: true },
};

const ASSEMBLYAI: AnalysisProviderDef = {
  id: 'assemblyai',
  label: 'AssemblyAI (transcripción + diarización)',
  processes: ['transcription'],
  envKeys: ['ASSEMBLYAI_API_KEY'],
  defaultModel: 'universal-3-pro',
  modelEnvKey: 'ASSEMBLYAI_SPEECH_MODEL',
  supports: { diarization: true },
};

const WHISPER: AnalysisProviderDef = {
  id: 'whisper',
  label: 'OpenAI Whisper (transcripción sin diarización)',
  processes: ['transcription'],
  envKeys: ['OPENAI_API_KEY'],
  defaultModel: 'whisper-1',
  modelEnvKey: 'WHISPER_MODEL',
  supports: {},
};

export const ANALYSIS_PROVIDERS: readonly AnalysisProviderDef[] = [
  GEMINI,
  OPENAI_VISION,
  ASSEMBLYAI,
  WHISPER,
];

/**
 * Orden de preferencia por proceso cuando no hay override explícito.
 * D-2 (tarjeta ÉPICA E): análisis = Gemini 3.x; transcripción = AssemblyAI
 * como timeline primario, Whisper fallback; imagen = Gemini.
 */
const PROCESS_PREFERENCES: Record<AnalysisProcess, readonly string[]> = {
  analysis: ['gemini', 'openai-vision'],
  transcription: ['assemblyai', 'whisper'],
  image: ['gemini', 'openai-vision'],
};

// ---------------------------------------------------------------------------
// Resolución
// ---------------------------------------------------------------------------

export function getAnalysisProvider(id: string): AnalysisProviderDef | undefined {
  return ANALYSIS_PROVIDERS.find((p) => p.id === id);
}

/** true si TODAS las env vars requeridas del proveedor están seteadas. */
export function isAnalysisProviderConfigured(id: string): boolean {
  const def = getAnalysisProvider(id);
  if (!def) return false;
  return def.envKeys.every((key) => Boolean(process.env[key]));
}

/** Env que fija el proveedor de un proceso (`ANALYSIS_PROVIDER_ANALYSIS`, …). */
export function providerOverrideEnvKey(proc: AnalysisProcess): string {
  return `ANALYSIS_PROVIDER_${proc.toUpperCase()}`;
}

/** Env que fija el modelo de un proceso (`ANALYSIS_MODEL_IMAGE`, …). */
export function modelOverrideEnvKey(proc: AnalysisProcess): string {
  return `ANALYSIS_MODEL_${proc.toUpperCase()}`;
}

function resolveModel(proc: AnalysisProcess, def: AnalysisProviderDef): string {
  return (
    process.env[modelOverrideEnvKey(proc)] ??
    (def.modelEnvKey ? process.env[def.modelEnvKey] : undefined) ??
    def.defaultModel
  );
}

function withResolution(
  proc: AnalysisProcess,
  def: AnalysisProviderDef,
  forced: boolean,
): ResolvedAnalysisProvider {
  return { ...def, model: resolveModel(proc, def), forced };
}

/**
 * Resuelve el proveedor efectivo para un proceso.
 *
 * 1. Si `ANALYSIS_PROVIDER_<PROCESO>` está seteada → ese proveedor, validado:
 *    debe existir, servir el proceso y estar configurado. Cualquier violación
 *    tira `AnalysisProviderConfigError` (la config explícita rota se reporta).
 * 2. Sin override → primer proveedor configurado en `PROCESS_PREFERENCES`.
 * 3. Ninguno configurado → `AnalysisProviderUnavailableError` con la lista de
 *    env vars que habilitarían cada candidato.
 */
export function resolveAnalysisProvider(proc: AnalysisProcess): ResolvedAnalysisProvider {
  const forcedId = process.env[providerOverrideEnvKey(proc)]?.trim();
  if (forcedId) {
    const def = getAnalysisProvider(forcedId);
    if (!def) {
      throw new AnalysisProviderConfigError(
        proc,
        forcedId,
        `proveedor desconocido (válidos: ${ANALYSIS_PROVIDERS.map((p) => p.id).join(', ')})`,
      );
    }
    if (!def.processes.includes(proc)) {
      throw new AnalysisProviderConfigError(
        proc,
        forcedId,
        `no sirve '${process}' (sirve: ${def.processes.join(', ')})`,
      );
    }
    if (!isAnalysisProviderConfigured(forcedId)) {
      throw new AnalysisProviderConfigError(
        proc,
        forcedId,
        `faltan env vars: ${def.envKeys.filter((k) => !process.env[k]).join(', ')}`,
      );
    }
    return withResolution(proc, def, true);
  }

  for (const id of PROCESS_PREFERENCES[proc]) {
    if (isAnalysisProviderConfigured(id)) {
      return withResolution(proc, getAnalysisProvider(id)!, false);
    }
  }

  const hint = PROCESS_PREFERENCES[proc]
    .map((id) => {
      const def = getAnalysisProvider(id)!;
      return `${id} (requiere ${def.envKeys.join(' + ')})`;
    })
    .join(' · ');
  throw new AnalysisProviderUnavailableError(proc, `configurá uno: ${hint}`);
}

/**
 * Todos los proveedores CONFIGURADOS que sirven un proceso, en orden de
 * preferencia — el caller itera la cadena de fallback (lo que hoy hace
 * `transcribeAudio` a mano). Con override explícito devuelve sólo ese.
 */
export function resolveAnalysisProviders(proc: AnalysisProcess): ResolvedAnalysisProvider[] {
  const forcedId = process.env[providerOverrideEnvKey(proc)]?.trim();
  if (forcedId) return [resolveAnalysisProvider(proc)];

  return PROCESS_PREFERENCES[proc]
    .filter((id) => isAnalysisProviderConfigured(id))
    .map((id) => withResolution(proc, getAnalysisProvider(id)!, false));
}

/**
 * Modelo efectivo de un proveedor puntual para un proceso:
 * `ANALYSIS_MODEL_<PROCESO>` → `modelEnvKey` del proveedor → `defaultModel`.
 */
export function resolveAnalysisModel(proc: AnalysisProcess, providerId: string): string {
  const def = getAnalysisProvider(providerId);
  if (!def) {
    throw new AnalysisProviderConfigError(proc, providerId, 'proveedor desconocido');
  }
  return resolveModel(proc, def);
}

/**
 * Lista el registry completo (o filtrado por proceso) con el flag `available`
 * resuelto — para superficies de diagnóstico/admin sin ejecutar nada.
 */
export function listAnalysisProviders(
  proc?: AnalysisProcess,
): (AnalysisProviderDef & { available: boolean })[] {
  return ANALYSIS_PROVIDERS.filter((p) => !proc || p.processes.includes(proc)).map((p) => ({
    ...p,
    available: isAnalysisProviderConfigured(p.id),
  }));
}
