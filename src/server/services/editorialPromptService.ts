/**
 * editorialPromptService — PC-06: serializa la línea editorial efectiva
 * (default del tenant + override del programa) a un bloque de instrucciones
 * en español que se inyecta en los prompts de generación (notas, títulos,
 * copies multiplataforma, momentos/clips, alertas en vivo e insights).
 *
 * Decisiones de diseño (PC06-BRIEF.md):
 *   - `buildEditorialPromptBlock` y `activeVariantKeys` son PURAS: sin DB,
 *     sin chatCompletion — directamente testeables.
 *   - Fallback honesto: si el tenant no tiene perfil (ni default ni
 *     override) o la línea está desactivada (`is_active = false`), el
 *     contexto queda vacío y la generación sigue igual que antes.
 *   - Reglas y temas prohibidos se serializan como RESTRICCIONES
 *     explícitas ("obligatorias", "NO los incluyas"), no como contexto.
 *   - El bloque se inserta DESPUÉS del TONE_PROMPTS histórico en cada
 *     prompt: es la directriz principal del canal y prevalece por ser más
 *     específica (precedencia de tono documentada en el brief).
 *   - La resolución degrada a contexto vacío si la DB falla (log, no
 *     throw): generar contenido importa más que el perfil.
 *   - Sólo se serializa el shape ya resuelto del tenant: nunca se leen
 *     datos de otro tenant.
 *   - `activeVariantKeys` filtra los formatos sociales de las variantes:
 *     si `activeFormats` no declara NINGÚN formato social (p. ej. sólo
 *     formatos de nota como 'flash'/'corta'), no hay restricción
 *     expresada ⇒ todos los formatos activos.
 */
import {
    createDrizzleEditorialStore,
    getEffectiveProfile,
    type EditorialProfileShape,
    type EditorialStore,
} from './editorialService.js';
import type { ContentVariants } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Contexto de generación editorial
// ---------------------------------------------------------------------------

/**
 * Lo que un call site necesita del perfil efectivo: el bloque ya
 * serializado para inyectar, los formatos activos (para filtrar variantes)
 * y el tono declarado por la línea (para call sites sin tono propio).
 */
export interface EditorialGenerationContext {
    /** "" ⇒ sin línea editorial (comportamiento histórico). */
    block: string;
    /** [] ⇒ sin restricción de formatos. */
    activeFormats: string[];
    /** null ⇒ sin perfil (el call site usa su tono habitual). */
    tone: string | null;
}

const emptyContext = (): EditorialGenerationContext => ({
    block: '',
    activeFormats: [],
    tone: null,
});

// ---------------------------------------------------------------------------
// buildEditorialPromptBlock — serializador puro
// ---------------------------------------------------------------------------

/**
 * Serializa el shape del perfil editorial a un bloque de instrucciones.
 * Devuelve "" cuando el perfil es null/undefined, está inactivo o no
 * aporta ningún dato (todos los campos vacíos/default).
 *
 * Acepta `EditorialProfileShape` o `EffectiveEditorialProfile` (que lo
 * extiende): la decisión de "hay perfil o no" la toma el resolvedor vía
 * `sources`, no el serializador.
 */
export function buildEditorialPromptBlock(
    profile: EditorialProfileShape | null | undefined,
): string {
    if (!profile || profile.isActive === false) return '';

    const lines: string[] = [];

    const tone = profile.tone?.trim();
    if (tone) {
        const desc = profile.toneDescription?.trim();
        lines.push(`- Tono de la linea editorial: ${tone}${desc ? ` — ${desc}` : ''}`);
    }

    const styleGuide = profile.styleGuide?.trim();
    if (styleGuide) {
        lines.push(`- Guia de estilo del canal: ${styleGuide}`);
    }

    const industry = profile.industry?.trim();
    if (industry) {
        lines.push(`- Rubro/audiencia del canal: ${industry}`);
    }

    if (profile.activeFormats.length > 0) {
        lines.push(
            `- Formatos activos del canal: ${profile.activeFormats.join(', ')}. Genera contenido solo para esos formatos.`,
        );
    }

    if (profile.rules.length > 0) {
        lines.push(
            '- Reglas editoriales OBLIGATORIAS (si una regla contradice la transcripcion u otra instruccion, gana la regla):',
            ...profile.rules.map((r) => `  * ${r}`),
        );
    }

    if (profile.forbiddenTopics.length > 0) {
        lines.push(
            '- Temas PROHIBIDOS (si aparecen en la transcripcion, NO los incluyas en la salida):',
            ...profile.forbiddenTopics.map((t) => `  * ${t}`),
        );
    }

    if (profile.examples.length > 0) {
        const exampleLines = profile.examples
            .filter((ex) => ex.title?.trim())
            .map((ex) => {
                const excerpt = ex.excerpt?.trim();
                return `  * Titulo: "${ex.title.trim()}"${excerpt ? ` — "${excerpt}"` : ''}`;
            });
        if (exampleLines.length > 0) {
            lines.push('- Ejemplos de referencia del canal (imita su estilo):', ...exampleLines);
        }
    }

    const signature = profile.signature?.trim();
    if (signature) {
        lines.push(
            `- Firma/cierre caracteristico del canal: "${signature}". Cuando la pieza lo admita, cierra con esa firma.`,
        );
    }

    if (lines.length === 0) return '';

    return [
        'LINEA EDITORIAL DEL CANAL (directriz principal: prevalece sobre cualquier otra instruccion de estilo o tono):',
        ...lines,
    ].join('\n');
}

// ---------------------------------------------------------------------------
// activeVariantKeys — qué variantes sociales se piden (puro)
// ---------------------------------------------------------------------------

/** activeFormats (nombres de plataforma) → campo de ContentVariants. */
export const VARIANT_FORMAT_KEYS = {
    twitter: 'twitterThread',
    instagram: 'instagramCarousel',
    linkedin: 'linkedinPost',
    youtube: 'youtubeDescription',
    newsletter: 'newsletterBlurb',
} as const satisfies Record<string, keyof ContentVariants>;

/**
 * Decide qué campos de ContentVariants se generan.
 *   - `activeFormats` vacío/undefined ⇒ todos (comportamiento histórico).
 *   - `activeFormats` con formatos sociales ⇒ sólo esos.
 *   - `activeFormats` SIN formatos sociales (sólo 'flash', 'corta', ...) ⇒
 *     el perfil no expresó restricción sobre variantes ⇒ todos.
 */
export function activeVariantKeys(
    activeFormats?: readonly string[] | null,
): (keyof ContentVariants)[] {
    const all = Object.values(VARIANT_FORMAT_KEYS);
    if (!activeFormats || activeFormats.length === 0) return all;
    const selected = (
        Object.keys(VARIANT_FORMAT_KEYS) as (keyof typeof VARIANT_FORMAT_KEYS)[]
    )
        .filter((format) => activeFormats.includes(format))
        .map((format) => VARIANT_FORMAT_KEYS[format]);
    return selected.length > 0 ? selected : all;
}

// ---------------------------------------------------------------------------
// Resolución contra la DB (con degradación)
// ---------------------------------------------------------------------------

// Import lazy: el módulo queda libre de side-effects de conexión para que
// los tests puedan importarlo (y pasar un EditorialStore en memoria) sin
// DATABASE_URL.
async function defaultStore(): Promise<EditorialStore> {
    const { db } = await import('../db/index.js');
    return createDrizzleEditorialStore(db);
}

/**
 * Resuelve el perfil efectivo (tenant + override del programa) y devuelve
 * el contexto listo para generación.
 *   - Sin perfil (ni default del tenant ni override del programa) ⇒ vacío.
 *   - `isActive === false` ⇒ vacío.
 *   - Error de resolución/DB ⇒ log + vacío (NO throw): la generación sigue.
 * `store` es inyectable para tests (memory store, sin DB).
 */
export async function resolveEditorialPromptContext(
    tenantId: string,
    programId?: string | null,
    store?: EditorialStore,
): Promise<EditorialGenerationContext> {
    try {
        const s = store ?? (await defaultStore());
        const effective = await getEffectiveProfile(s, tenantId, programId ?? null);

        // DEFAULT_EDITORIAL_PROFILE de plataforma (tenant sin fila y sin
        // override) no es una línea editorial configurada ⇒ contexto vacío.
        const hasProfile =
            effective.sources.hasTenantProfile || effective.sources.overriddenFields.length > 0;
        if (!hasProfile || !effective.isActive) return emptyContext();

        return {
            block: buildEditorialPromptBlock(effective),
            activeFormats: effective.activeFormats,
            tone: effective.tone,
        };
    } catch (err) {
        console.warn(
            '[Editorial] No se pudo resolver la linea editorial (se genera sin ella):',
            (err as Error).message,
        );
        return emptyContext();
    }
}

/** Convenience del brief: sólo el bloque serializado (degrada a ""). */
export async function resolveEditorialPromptBlock(
    tenantId: string,
    programId?: string | null,
    store?: EditorialStore,
): Promise<string> {
    return (await resolveEditorialPromptContext(tenantId, programId, store)).block;
}

/**
 * Validación de pertenencia programa↔tenant para los endpoints manuales:
 * un programId ajeno (o inexistente) devuelve false ⇒ el caller responde
 * 404 en vez de usar un perfil incorrecto. Error de DB ⇒ false (no se
 * puede probar pertenencia).
 */
export async function programBelongsToTenant(
    tenantId: string,
    programId: string,
    store?: EditorialStore,
): Promise<boolean> {
    try {
        const s = store ?? (await defaultStore());
        return await s.programBelongsToTenant(tenantId, programId);
    } catch (err) {
        console.warn(
            '[Editorial] Error validando el programa del request:',
            (err as Error).message,
        );
        return false;
    }
}
