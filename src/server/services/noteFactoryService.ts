/**
 * noteFactoryService — notas periodísticas por rubro con citas atribuidas
 * (PF-06).
 *
 * Del material ya analizado de una transmisión (`transmission_segments` del
 * motor PE-02 + citas con `persons.name` resueltas computed-on-read por
 * PE-05) genera una NOTA del rubro editorial pedido y la persiste en
 * `publications` (`source='pipeline'`, `status='pending_review'` — el
 * circuito de revisión existente la toma desde ahí).
 *
 * Rubros (NO son los formatos de red de EDITORIAL_FORMATS — esos los
 * multiplica PF-09): `flash` | `corta` | `completa` | `cronica`, cada uno
 * con su plantilla (`RUBRO_TEMPLATES`). `buildNotePrompt` y
 * `parseNoteResponse` son PURAS — el corazón testeable del slice.
 *
 * Contratos heredados — nada se reimplementa:
 *   - `attributedQuotesService.listAttributedQuotes` (PE-05): citas con
 *     personName/foto ya resueltos. Las citas se embedden en el prompt como
 *     `“texto” — Nombre` y se guardan tal cual en `publications.quotes`
 *     (jsonb) — así la nota muestra quién dijo qué.
 *   - `resolveEditorialPromptBlock` (PC-06): bloque de línea editorial del
 *     tenant (tono, reglas, formatos) que encabeza el prompt; degrada a ""
 *     sin perfil.
 *   - `programBelongsToTenant` (PC-06): valida el programId opcional — un
 *     programa ajeno ⇒ `invalid_program`, nunca un perfil incorrecto.
 *   - `resolveAnalysisProvider('analysis')` + `callAnalysisProvider`
 *     (PE-01/PE-02): el `generate` default — mismo provider del motor,
 *     nunca hardcodeado. El import es lazy (como `defaultStore` de
 *     editorialPromptService): el módulo queda liviano y los tests no
 *     cargan el engine completo.
 *   - `publications.quotes` ya es jsonb: cero migraciones, insert directo
 *     del store propio (createPublication de databaseService exige tenant
 *     por parámetro pero su shape mapeado no devuelve quotes/status —
 *     el store propio devuelve la fila completa).
 *
 * Patrón del repo: `NoteFactoryStore` + impl drizzle + memory store en
 * tests — TODA query filtra por `tenant_id`. `generate` es dep inyectable:
 * los tests usan un fake determinista, NUNCA el provider real.
 *
 * Errores de dominio como `AppError` con `code` — la ruta los mapea tal
 * cual: transmission_not_found (404), invalid_program (404),
 * invalid_format (422), no_content (422), invalid_model_response (502).
 */
import { and, asc, eq } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { publications } from '../db/schema/publications.js';
import {
    transmissionSegments,
    type TransmissionSegmentSpeaker,
} from '../db/schema/live.js';
import { transmissions } from '../db/schema/transmissions.js';
import type { PublicationSource } from '../db/schema/enums.js';
import { AppError } from '../lib/errors.js';
import { resolveAnalysisProvider } from '../lib/analysisProviders.js';
import {
    attributedQuotesService,
    type AttributedQuote,
} from './attributedQuotesService.js';
import {
    programBelongsToTenant,
    resolveEditorialPromptBlock,
} from './editorialPromptService.js';

// ---------------------------------------------------------------------------
// Rubros editoriales — una plantilla por rubro (puro, sin DB)
// ---------------------------------------------------------------------------

export const NOTE_RUBROS = ['flash', 'corta', 'completa', 'cronica'] as const;
export type NoteRubro = (typeof NOTE_RUBROS)[number];

export interface RubroTemplate {
    key: NoteRubro;
    /** Rótulo humano del rubro (va en el prompt). */
    label: string;
    /** Instrucciones de forma/extensión que el modelo debe seguir. */
    instructions: string;
    /** Techo del cuerpo generado, si el rubro lo declara. */
    maxChars?: number;
    /** false ⇒ el prompt omite la sección de citas y la nota no las "usa". */
    includeQuotes: boolean;
}

/**
 * Plantillas por rubro. Las instrucciones se inyectan verbatim en el
 * prompt — el test verifica que cada rubro produce un prompt distinto.
 *
 * `flash` es el único sin citas: un breaking de 3-4 líneas + bullets va al
 * hecho, no hay espacio ni tiempo para atribuir — las citas igual quedan
 * disponibles en los demás rubros.
 */
export const RUBRO_TEMPLATES: Record<NoteRubro, RubroTemplate> = {
    flash: {
        key: 'flash',
        label: 'Flash informativo (breaking)',
        instructions:
            'Redactá un FLASH INFORMATIVO breaking: 3-4 líneas con el hecho central (qué pasó, quién, dónde) seguidas de 2-3 bullets con los datos clave. Directo, sin introducción ni cierre. NO incluyas citas textuales: el flash es sólo hechos.',
        maxChars: 400,
        includeQuotes: false,
    },
    corta: {
        key: 'corta',
        label: 'Nota corta',
        instructions:
            'Redactá una NOTA CORTA: UN solo párrafo de 4-6 líneas con lo esencial del tema principal, seguido de UNA cita textual relevante entrecomillada con su autor (formato: “cita” — Nombre).',
        maxChars: 900,
        includeQuotes: true,
    },
    completa: {
        key: 'completa',
        label: 'Nota completa',
        instructions:
            'Redactá una NOTA COMPLETA: lead con las 5W (qué, quién, cuándo, dónde, por qué), 3 párrafos de cuerpo desarrollando los segmentos en orden de relevancia, y un cierre con proyección o contexto. Integrá al menos 2 citas textuales entrecomilladas con su autor (“cita” — Nombre).',
        maxChars: 3200,
        includeQuotes: true,
    },
    cronica: {
        key: 'cronica',
        label: 'Crónica',
        instructions:
            'Redactá una CRÓNICA: narrativa en ORDEN TEMPORAL siguiendo la franja mm:ss de los segmentos — el relato cuenta cómo se fue desarrollando la emisión, con tono descriptivo. Entretejé las citas textuales con su autor (“cita” — Nombre) en el momento de la narración donde ocurrieron.',
        maxChars: 4500,
        includeQuotes: true,
    },
};

// ---------------------------------------------------------------------------
// Tipos del dominio
// ---------------------------------------------------------------------------

/** Lo que el servicio necesita de la transmisión (tenant-scoped). */
export interface NoteTransmission {
    id: string;
    programId: string | null;
    status: string;
}

/** Segmento temático (transmission_segments) con su franja en ms. */
export interface NoteSegment {
    id: string;
    startMs: number;
    endMs: number;
    topic: string | null;
    summary: string | null;
    speakers: TransmissionSegmentSpeaker[];
}

/** Fila completa de `publications` ya insertada. */
export type NotePublication = typeof publications.$inferSelect;

export interface InsertNotePublicationInput {
    tenantId: string;
    title: string;
    content: string;
    /** Citas atribuidas USADAS (jsonb tal cual — incluye personName). */
    quotes: AttributedQuote[];
    source: PublicationSource;
    status: string;
}

/** Metadatos de la transmisión que el prompt expone como contexto. */
export interface NoteTransmissionMeta {
    status?: string | null;
    programName?: string | null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface NoteFactoryStore {
    /** Transmisión del tenant; null si no existe o es ajena. */
    getTransmission(
        tenantId: string,
        transmissionId: string,
    ): Promise<NoteTransmission | null>;
    /** Segmentos temáticos de la transmisión, ordenados por start_ms. */
    listSegments(
        tenantId: string,
        transmissionId: string,
    ): Promise<NoteSegment[]>;
    /** Inserta la nota generada; devuelve la fila completa. */
    insertPublication(v: InsertNotePublicationInput): Promise<NotePublication>;
}

/** Implementación drizzle — todas las queries filtran por tenant_id. */
export function createDrizzleNoteFactoryStore(
    executor: Database = db,
): NoteFactoryStore {
    return {
        async getTransmission(tenantId, transmissionId) {
            const [row] = await executor
                .select({
                    id: transmissions.id,
                    programId: transmissions.programId,
                    status: transmissions.status,
                })
                .from(transmissions)
                .where(
                    and(
                        eq(transmissions.tenantId, tenantId),
                        eq(transmissions.id, transmissionId),
                    ),
                )
                .limit(1);
            return row ?? null;
        },

        async listSegments(tenantId, transmissionId) {
            return executor
                .select({
                    id: transmissionSegments.id,
                    startMs: transmissionSegments.startMs,
                    endMs: transmissionSegments.endMs,
                    topic: transmissionSegments.topic,
                    summary: transmissionSegments.summary,
                    speakers: transmissionSegments.speakers,
                })
                .from(transmissionSegments)
                .where(
                    and(
                        eq(transmissionSegments.tenantId, tenantId),
                        eq(transmissionSegments.transmissionId, transmissionId),
                    ),
                )
                .orderBy(asc(transmissionSegments.startMs));
        },

        async insertPublication(v) {
            const [row] = await executor
                .insert(publications)
                .values({
                    tenantId: v.tenantId,
                    title: v.title,
                    content: v.content,
                    quotes: v.quotes,
                    source: v.source,
                    status: v.status,
                })
                .returning();
            return row;
        },
    };
}

// ---------------------------------------------------------------------------
// buildNotePrompt — constructor del prompt (puro)
// ---------------------------------------------------------------------------

/** ms → "mm:ss" (los minutos pueden superar 59 en transmisiones largas). */
export function formatMsTimestamp(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Nombre visible de la cita: persona real → label genérico → fallback. */
function quoteAuthor(q: AttributedQuote): string {
    return q.personName ?? q.speakerLabel ?? 'Vocero sin identificar';
}

export interface BuildNotePromptInput {
    /** Rubro pedido — ya validado contra RUBRO_TEMPLATES. */
    format: NoteRubro;
    segments: NoteSegment[];
    quotes: AttributedQuote[];
    /** Bloque de línea editorial serializado (PC-06); "" ⇒ sin perfil. */
    editorialBlock?: string;
    transmissionMeta?: NoteTransmissionMeta;
}

/**
 * Prompt de generación de la nota, determinista: editorialBlock primero
 * (directriz principal del canal), luego las instrucciones del rubro, los
 * segmentos con su franja `mm:ss–mm:ss`, las citas atribuidas
 * `“texto” — Nombre` (sólo si el template las incluye) y el contrato de
 * salida JSON `{"title": "...", "body": "..."}`.
 */
export function buildNotePrompt(input: BuildNotePromptInput): string {
    const template = RUBRO_TEMPLATES[input.format];
    const parts: string[] = [];

    const editorial = input.editorialBlock?.trim();
    if (editorial) parts.push(editorial);

    const meta = input.transmissionMeta;
    const metaLines = [
        meta?.status ? `- Estado de la transmisión: ${meta.status}` : null,
        meta?.programName ? `- Programa: ${meta.programName}` : null,
    ].filter((l): l is string => l !== null);

    const segmentLines = input.segments.map((s) => {
        const title = s.topic?.trim() || s.summary?.trim() || 'Segmento sin título';
        const detail =
            s.topic?.trim() && s.summary?.trim() ? ` — ${s.summary.trim()}` : '';
        const voices = s.speakers?.length
            ? ` (voces: ${s.speakers.map((sp) => sp.label).join(', ')})`
            : '';
        return `- [${formatMsTimestamp(s.startMs)}–${formatMsTimestamp(s.endMs)}] ${title}${detail}${voices}`;
    });

    const quoteLines = template.includeQuotes
        ? input.quotes
              .filter((q) => q.text?.trim())
              .map((q) => `- “${q.text!.trim()}” — ${quoteAuthor(q)}`)
        : [];

    parts.push(
        [
            `Sos un redactor del canal. Generá una nota periodística del rubro "${template.label}" a partir de los segmentos ya analizados de una transmisión.`,
            '',
            'INSTRUCCIONES DEL RUBRO:',
            template.instructions,
            ...(template.maxChars
                ? [`Extensión máxima del cuerpo: ${template.maxChars} caracteres.`]
                : []),
            ...(metaLines.length
                ? ['', 'CONTEXTO DE LA TRANSMISIÓN:', ...metaLines]
                : []),
            '',
            'SEGMENTOS DE LA TRANSMISIÓN (orden cronológico, franja mm:ss relativa al inicio):',
            ...segmentLines,
            ...(quoteLines.length
                ? [
                      '',
                      'CITAS ATRIBUIDAS (entrecomillalas siempre con su autor tal cual aparece):',
                      ...quoteLines,
                  ]
                : []),
            '',
            'FORMATO DE RESPUESTA — OBLIGATORIO:',
            'Respondé SOLO un objeto JSON válido, sin markdown ni texto alrededor, con esta forma exacta:',
            '{"title": "título de la nota", "body": "cuerpo completo de la nota"}',
        ].join('\n'),
    );

    return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// parseNoteResponse — parseo defensivo del resultado (puro)
// ---------------------------------------------------------------------------

export interface ParsedNoteResponse {
    title: string;
    body: string;
}

/** Mismo patrón que `extractJson` del motor: tolera ```json fences. */
function extractJson(raw: string): string {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    return (fenced ? fenced[1] : raw).trim();
}

/**
 * `{"title": "...", "body": "..."}` → {title, body}. JSON inválido, sin
 * title o sin body ⇒ `AppError` 502 `invalid_model_response` (el modelo
 * falló — la ruta lo reporta como upstream, no como input del usuario).
 */
export function parseNoteResponse(raw: string): ParsedNoteResponse {
    let parsed: unknown;
    try {
        parsed = JSON.parse(extractJson(raw));
    } catch {
        throw new AppError(
            'La respuesta del modelo no es un JSON válido',
            502,
            'invalid_model_response',
        );
    }

    const obj =
        parsed && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>)
            : null;
    const title = typeof obj?.title === 'string' ? obj.title.trim() : '';
    const body = typeof obj?.body === 'string' ? obj.body.trim() : '';
    if (!title || !body) {
        throw new AppError(
            'La respuesta del modelo no trae "title" y "body" válidos',
            502,
            'invalid_model_response',
        );
    }
    return { title, body };
}

// ---------------------------------------------------------------------------
// generateNote — flujo completo
// ---------------------------------------------------------------------------

export interface GenerateNoteInput {
    tenantId: string;
    transmissionId: string;
    /** Rubro pedido — validado contra RUBRO_TEMPLATES. */
    format: string;
    programId?: string | null;
}

/** El modelo por prompt — inyectable; los tests usan fake determinista. */
export type NoteGenerateFn = (prompt: string) => Promise<string>;

export interface GenerateNoteDeps {
    store?: NoteFactoryStore;
    generate?: NoteGenerateFn;
    editorialBlock?: (
        tenantId: string,
        programId?: string | null,
    ) => Promise<string>;
    listQuotes?: (
        tenantId: string,
        transmissionId: string,
    ) => Promise<AttributedQuote[]>;
    programBelongsToTenant?: (
        tenantId: string,
        programId: string,
    ) => Promise<boolean>;
    now?: () => Date;
}

export interface GenerateNoteResult {
    publication: NotePublication;
    segmentsUsed: number;
    quotesUsed: number;
    generatedAt: Date;
}

/**
 * `generate` default: el provider resuelto de 'analysis' (PE-01) llamado
 * por `callAnalysisProvider` (PE-02). Import lazy — el módulo no carga el
 * engine completo para quien sólo usa las funciones puras, y los tests
 * nunca llegan acá (siempre inyectan `generate`).
 */
const defaultGenerate: NoteGenerateFn = async (prompt) => {
    const { callAnalysisProvider } = await import('./analysisEngineService.js');
    const provider = resolveAnalysisProvider('analysis');
    return callAnalysisProvider(provider, prompt);
};

/**
 * Genera la nota del rubro para una transmisión:
 *   formato → transmisión del tenant → programa válido → segmentos+citas
 *   en paralelo (sin segmentos ⇒ `no_content`, nunca nota vacía) → prompt
 *   con línea editorial → generate → parse → insert en `publications` con
 *   las citas atribuidas usadas embebidas en jsonb.
 */
export async function generateNote(
    input: GenerateNoteInput,
    deps: GenerateNoteDeps = {},
): Promise<GenerateNoteResult> {
    const template = RUBRO_TEMPLATES[input.format as NoteRubro];
    if (!template) {
        throw new AppError(
            `Rubro inválido: '${input.format}'. Válidos: ${NOTE_RUBROS.join(', ')}`,
            422,
            'invalid_format',
        );
    }

    const store = deps.store ?? createDrizzleNoteFactoryStore();
    const belongsToTenant = deps.programBelongsToTenant ?? programBelongsToTenant;
    const listQuotes =
        deps.listQuotes ??
        ((tenantId: string, transmissionId: string) =>
            attributedQuotesService.listAttributedQuotes(tenantId, transmissionId));
    const editorialBlock = deps.editorialBlock ?? resolveEditorialPromptBlock;
    const generate = deps.generate ?? defaultGenerate;
    const now = deps.now ?? (() => new Date());

    const transmission = await store.getTransmission(
        input.tenantId,
        input.transmissionId,
    );
    if (!transmission) {
        throw new AppError('Transmisión no encontrada', 404, 'transmission_not_found');
    }

    const programId = input.programId ?? null;
    if (programId && !(await belongsToTenant(input.tenantId, programId))) {
        throw new AppError('Programa no encontrado', 404, 'invalid_program');
    }

    const [segments, quotes, block] = await Promise.all([
        store.listSegments(input.tenantId, input.transmissionId),
        listQuotes(input.tenantId, input.transmissionId),
        editorialBlock(input.tenantId, programId),
    ]);

    if (segments.length === 0) {
        throw new AppError(
            'La transmisión no tiene segmentos analizados: no hay contenido para la nota',
            422,
            'no_content',
        );
    }

    const prompt = buildNotePrompt({
        format: template.key,
        segments,
        quotes,
        editorialBlock: block,
        transmissionMeta: { status: transmission.status },
    });

    const raw = await generate(prompt);
    const { title, body } = parseNoteResponse(raw);

    // "Citas usadas" = las que el modelo efectivamente vio en el prompt:
    // un template sin includeQuotes no las usó — publication.quotes y
    // quotesUsed cuentan la misma verdad.
    const usedQuotes = template.includeQuotes ? quotes : [];

    const publication = await store.insertPublication({
        tenantId: input.tenantId,
        title,
        content: body,
        quotes: usedQuotes,
        source: 'pipeline',
        status: 'pending_review',
    });

    return {
        publication,
        segmentsUsed: segments.length,
        quotesUsed: usedQuotes.length,
        generatedAt: now(),
    };
}
