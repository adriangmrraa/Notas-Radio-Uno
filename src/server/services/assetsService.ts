/**
 * assetsService — ledger editorial unificado (PF-10, cierra ÉPICA F).
 *
 * Después de PF-01..09 el contenido vive en DOS tablas: `clips` (videos)
 * y `publications` (notas con `quote_flyer_paths` + `contentVariants`).
 * Este slice agrega la vista unificada `assets` (clip | note | flyer |
 * post) con estados editoriales CANÓNICOS.
 *
 * Decisión de diseño (del brief, no negociable): `assets` es un LEDGER
 * sobre las tablas existentes, NO un merge destructivo — un merge real
 * de clips+publications tocaría los 9 slices que ya las consumen (blast
 * radius enorme, no entra en 5pts ni es seguro). Consecuencias:
 *   - 1 fila por artefacto, referencia estable `(source_table, ref_id)`
 *     UNIQUE con tenant_id → idempotencia del sync.
 *   - Los 9 services anteriores NO se tocan: el ledger se puebla por
 *     `syncAssets` (pull), no por hooks en los producers.
 *   - Las transiciones escriben en AMBOS lados (write-through): el asset
 *     guarda el estado canónico y la fila fuente recibe el status legacy
 *     equivalente — los consumers viejos siguen viendo su estado.
 *
 * Máquina de estados canónica (`ASSET_TRANSITIONS`):
 *   draft → pending_review → approved → published
 *   pending_review → archived | approved → archived
 *   published y archived son terminales. `canTransition` es pura.
 *
 * `mapLegacyStatus` (pura) traduce los statuses heterogéneos legacy al
 * canónico. `toLegacyStatus` es el inverso para el write-through —
 * `archived` devuelve null a propósito: NO tiene legacy (archivar una
 * publicación NO la marca 'rejected'; archived solo toca el asset).
 *
 * `ref_id` de los flyers es un uuid v5 DETERMINISTA de
 * `${publicationId}:flyer:${quoteIndex}` (namespace fijo propio): el flyer
 * vive dentro del jsonb `quote_flyer_paths` — no es fila real — y el v5
 * garantiza que re-correr el sync cae en la MISMA fila del ledger (la
 * UNIQUE hace el resto).
 *
 * Errores de dominio como `AppError` con `code` (patrón PF-06..09):
 * asset_not_found (404), invalid_state (422), invalid_transition (409).
 *
 * Patrón del repo: `AssetStore` + `createDrizzleAssetStore` + memory store
 * en tests — TODA query filtra por `tenant_id`.
 */
import { and, eq } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';

import { db, type Database } from '../db/index.js';
import { assets } from '../db/schema/assets.js';
import { clips } from '../db/schema/clips.js';
import { publications } from '../db/schema/publications.js';
import { AppError } from '../lib/errors.js';

// ---------------------------------------------------------------------------
// Tipos del dominio
// ---------------------------------------------------------------------------

/** Kinds del ledger. 'post' existe en el modelo aunque ningún producer lo emite todavía. */
export const ASSET_KINDS = ['clip', 'note', 'flyer', 'post'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** Tablas fuente del ledger — las únicas dos que existen post-PF-09. */
export const ASSET_SOURCE_TABLES = ['clips', 'publications'] as const;
export type AssetSourceTable = (typeof ASSET_SOURCE_TABLES)[number];

/** Estados editoriales canónicos (el `status` del asset). */
export const ASSET_STATES = [
    'draft',
    'pending_review',
    'approved',
    'published',
    'archived',
] as const;
export type AssetState = (typeof ASSET_STATES)[number];

/** Type guards para validar input externo (query/body HTTP). */
export function isAssetKind(v: string): v is AssetKind {
    return (ASSET_KINDS as readonly string[]).includes(v);
}
export function isAssetState(v: string): v is AssetState {
    return (ASSET_STATES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Máquina de estados (pura)
// ---------------------------------------------------------------------------

/**
 * Aristas permitidas. Lineal hacia adelante; `archived` se puede alcanzar
 * sólo desde pending_review/approved (un draft nunca se archiva sin
 * revisión, un published no se "des-publica": queda published o se crea
 * otro artefacto). Sin auto-transiciones: `to === from` nunca es válido.
 */
export const ASSET_TRANSITIONS: Record<AssetState, readonly AssetState[]> = {
    draft: ['pending_review'],
    pending_review: ['approved', 'archived'],
    approved: ['published', 'archived'],
    published: [],
    archived: [],
};

/** `canTransition` pura: true sólo si `from → to` es arista del grafo. */
export function canTransition(from: string, to: string): boolean {
    const edges = ASSET_TRANSITIONS[from as AssetState];
    return Array.isArray(edges) && (edges as readonly string[]).includes(to);
}

// ---------------------------------------------------------------------------
// Mapeo legacy ↔ canónico (puras)
// ---------------------------------------------------------------------------

/**
 * clips legacy → canónico. `error` → draft: el artefacto existe pero no
 * avanzó (el detalle del error viaja en payload.error — el map es sólo
 * de estados). Status desconocido → draft (conservador: el sync nunca
 * rompe ni inventa un estado avanzado para un status nuevo legacy).
 */
const CLIP_STATUS_MAP: Record<string, AssetState> = {
    generating: 'draft',
    pending_review: 'pending_review',
    ready: 'approved',
    published: 'published',
    error: 'draft',
};

/** publications legacy → canónico. `rejected` → archived (única forma legacy de "fuera de circulación"). */
const PUBLICATION_STATUS_MAP: Record<string, AssetState> = {
    pending_review: 'pending_review',
    approved: 'approved',
    published: 'published',
    rejected: 'archived',
};

/**
 * Status legacy → estado canónico. Pura y total: cualquier string entra,
 * un AssetState sale (desconocido ⇒ draft).
 */
export function mapLegacyStatus(
    sourceTable: AssetSourceTable | string,
    legacyStatus: string,
): AssetState {
    const map =
        sourceTable === 'clips' ? CLIP_STATUS_MAP : PUBLICATION_STATUS_MAP;
    return map[legacyStatus] ?? 'draft';
}

/**
 * Canónico → status legacy para el write-through de `transitionAsset`.
 * `draft` figura por completitud pero es INALCANZABLE (la máquina no tiene
 * aristas hacia draft). `archived` → null EN AMBAS tablas: archivar es un
 * concepto del ledger sin equivalente legacy — archivar una nota NO la
 * marca 'rejected' ni toca la fuente.
 */
const CANONICAL_TO_CLIP_STATUS: Record<AssetState, string | null> = {
    draft: 'generating',
    pending_review: 'pending_review',
    approved: 'ready',
    published: 'published',
    archived: null,
};
const CANONICAL_TO_PUBLICATION_STATUS: Record<AssetState, string | null> = {
    draft: 'pending_review',
    pending_review: 'pending_review',
    approved: 'approved',
    published: 'published',
    archived: null,
};

/**
 * Estado canónico → status legacy de la fila fuente, o null si la
 * transición no tiene write-through (sólo `archived` hoy).
 */
export function toLegacyStatus(
    sourceTable: AssetSourceTable | string,
    canonical: AssetState | string,
): string | null {
    const map =
        sourceTable === 'clips'
            ? CANONICAL_TO_CLIP_STATUS
            : CANONICAL_TO_PUBLICATION_STATUS;
    const legacy = map[canonical as AssetState];
    return legacy === undefined ? null : legacy;
}

// ---------------------------------------------------------------------------
// ref_id determinista de flyers (uuid v5)
// ---------------------------------------------------------------------------

/**
 * Namespace uuid propio para derivar `ref_id` de flyers. NO es un uuid de
 * fila real: el flyer vive en `publications.quote_flyer_paths` (jsonb).
 * v5(namespace, `${pubId}:flyer:${i}`) → mismo input, mismo uuid, en
 * cualquier proceso y corrida → el re-sync cae en la MISMA fila del
 * ledger gracias a la UNIQUE (tenant_id, source_table, ref_id).
 * Elegido sobre "string estable en payload" porque ref_id es columna
 * uuid: un identificador tipado que además permite direccionar el flyer
 * por id sin lookup al jsonb.
 */
export const FLYER_REF_NAMESPACE = 'a5e10f10-b17f-4e10-a551-0a55e75f10e0';

/** ref_id determinista del flyer `quoteIndex` de `publicationId`. */
export function flyerRefId(publicationId: string, quoteIndex: number): string {
    return uuidv5(
        `${publicationId}:flyer:${quoteIndex}`,
        FLYER_REF_NAMESPACE,
    );
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Fila del ledger tal cual se lee/escribe. */
export interface AssetRow {
    id: string;
    tenantId: string;
    kind: string;
    sourceTable: string;
    refId: string;
    parentAssetId: string | null;
    title: string | null;
    status: string;
    payload: Record<string, unknown>;
    transmissionId: string | null;
    createdAt: Date;
    updatedAt: Date;
}

/** Input del upsert — `status` se aplica SÓLO en el insert inicial. */
export interface AssetUpsertInput {
    tenantId: string;
    kind: AssetKind;
    sourceTable: AssetSourceTable;
    refId: string;
    parentAssetId?: string | null;
    title?: string | null;
    status: AssetState;
    payload?: Record<string, unknown>;
    transmissionId?: string | null;
}

export interface AssetListFilters {
    kind?: string;
    status?: string;
    transmissionId?: string;
}

/** Lo que el sync necesita de `clips` (tenant-scoped). */
export interface LedgerClipRow {
    id: string;
    title: string;
    status: string;
    videoPath: string | null;
    duration: number;
    transmissionId: string | null;
    /** jsonb — de acá sale payload.error cuando status='error'. */
    metadata: unknown;
}

/** Lo que el sync necesita de `publications` (tenant-scoped). */
export interface LedgerPublicationRow {
    id: string;
    title: string | null;
    status: string;
    content: string | null;
    /** jsonb — array de paths de flyers (PF-07); `unknown` hasta validar. */
    quoteFlyerPaths: unknown;
}

export interface AssetStore {
    /**
     * INSERT … ON CONFLICT (tenant_id, source_table, ref_id) DO UPDATE
     * title/payload/parent_asset_id/transmission_id/updated_at.
     * `status` NO se pisa en el conflicto: una vez que el asset transicionó
     * manualmente el sync nunca retrocede su estado editorial. Los campos
     * estructurales (padre, transmisión) sí se refrescan — son hechos del
     * sync, no estado editorial.
     */
    upsertAsset(row: AssetUpsertInput): Promise<AssetRow>;
    /** Asset del tenant; null si no existe o es ajeno. */
    getAsset(id: string, tenantId: string): Promise<AssetRow | null>;
    /** Assets del tenant con filtros opcionales (kind/status/transmission). */
    listAssets(
        tenantId: string,
        filters?: AssetListFilters,
    ): Promise<AssetRow[]>;
    /**
     * UPDATE del status canónico (la máquina validó antes). Devuelve la
     * fila actualizada o null si no existe/es ajena.
     */
    setAssetStatus(
        id: string,
        tenantId: string,
        status: string,
    ): Promise<AssetRow | null>;
    /**
     * Write-through: UPDATE del status legacy en la tabla fuente
     * (`clips` o `publications`), filtrado por tenant_id. Si ref_id no
     * matchea ninguna fila (flyer: ref derivado, no es row) es no-op
     * por diseño.
     */
    updateSourceStatus(
        sourceTable: AssetSourceTable,
        refId: string,
        tenantId: string,
        legacyStatus: string,
    ): Promise<void>;
    /** Clips del tenant (opcionalmente de una transmisión). */
    listClips(
        tenantId: string,
        transmissionId?: string,
    ): Promise<LedgerClipRow[]>;
    /** Publicaciones del tenant con sus flyer paths (1 query, sin N+1). */
    listPublications(tenantId: string): Promise<LedgerPublicationRow[]>;
    /** Flyer paths normalizados a string[] de UNA publicación del tenant. */
    listPublicationFlyerPaths(
        tenantId: string,
        publicationId: string,
    ): Promise<string[]>;
}

/** Implementación drizzle — TODA query filtra por tenant_id. */
export function createDrizzleAssetStore(
    executor: Database = db,
): AssetStore {
    return {
        async upsertAsset(row) {
            const [asset] = await executor
                .insert(assets)
                .values({
                    tenantId: row.tenantId,
                    kind: row.kind,
                    sourceTable: row.sourceTable,
                    refId: row.refId,
                    parentAssetId: row.parentAssetId ?? null,
                    title: row.title ?? null,
                    status: row.status,
                    payload: row.payload ?? {},
                    transmissionId: row.transmissionId ?? null,
                })
                .onConflictDoUpdate({
                    target: [
                        assets.tenantId,
                        assets.sourceTable,
                        assets.refId,
                    ],
                    set: {
                        title: row.title ?? null,
                        payload: row.payload ?? {},
                        parentAssetId: row.parentAssetId ?? null,
                        transmissionId: row.transmissionId ?? null,
                        updatedAt: new Date(),
                        // status preservado — el sync nunca retrocede
                        // un estado editorial.
                    },
                })
                .returning();
            return asset;
        },

        async getAsset(id, tenantId) {
            const [row] = await executor
                .select()
                .from(assets)
                .where(and(eq(assets.id, id), eq(assets.tenantId, tenantId)))
                .limit(1);
            return row ?? null;
        },

        async listAssets(tenantId, filters = {}) {
            const conds = [eq(assets.tenantId, tenantId)];
            if (filters.kind) conds.push(eq(assets.kind, filters.kind));
            if (filters.status)
                conds.push(eq(assets.status, filters.status));
            if (filters.transmissionId)
                conds.push(
                    eq(assets.transmissionId, filters.transmissionId),
                );
            return executor
                .select()
                .from(assets)
                .where(and(...conds))
                .orderBy(assets.createdAt, assets.id);
        },

        async setAssetStatus(id, tenantId, status) {
            const [row] = await executor
                .update(assets)
                .set({ status })
                .where(and(eq(assets.id, id), eq(assets.tenantId, tenantId)))
                .returning();
            return row ?? null;
        },

        async updateSourceStatus(sourceTable, refId, tenantId, legacyStatus) {
            if (sourceTable === 'clips') {
                await executor
                    .update(clips)
                    .set({ status: legacyStatus })
                    .where(
                        and(
                            eq(clips.id, refId),
                            eq(clips.tenantId, tenantId),
                        ),
                    );
            } else {
                await executor
                    .update(publications)
                    .set({ status: legacyStatus })
                    .where(
                        and(
                            eq(publications.id, refId),
                            eq(publications.tenantId, tenantId),
                        ),
                    );
            }
        },

        async listClips(tenantId, transmissionId) {
            const conds = [eq(clips.tenantId, tenantId)];
            if (transmissionId)
                conds.push(eq(clips.transmissionId, transmissionId));
            return executor
                .select({
                    id: clips.id,
                    title: clips.title,
                    status: clips.status,
                    videoPath: clips.videoPath,
                    duration: clips.duration,
                    transmissionId: clips.transmissionId,
                    metadata: clips.metadata,
                })
                .from(clips)
                .where(and(...conds))
                .orderBy(clips.createdAt, clips.id);
        },

        async listPublications(tenantId) {
            return executor
                .select({
                    id: publications.id,
                    title: publications.title,
                    status: publications.status,
                    content: publications.content,
                    quoteFlyerPaths: publications.quoteFlyerPaths,
                })
                .from(publications)
                .where(eq(publications.tenantId, tenantId))
                .orderBy(publications.createdAt, publications.id);
        },

        async listPublicationFlyerPaths(tenantId, publicationId) {
            const [row] = await executor
                .select({ quoteFlyerPaths: publications.quoteFlyerPaths })
                .from(publications)
                .where(
                    and(
                        eq(publications.id, publicationId),
                        eq(publications.tenantId, tenantId),
                    ),
                )
                .limit(1);
            return toStringArray(row?.quoteFlyerPaths);
        },
    };
}

// ---------------------------------------------------------------------------
// Deps inyectables
// ---------------------------------------------------------------------------

export interface AssetServiceDeps {
    store?: AssetStore;
}

const resolveStore = (deps?: AssetServiceDeps): AssetStore =>
    deps?.store ?? createDrizzleAssetStore();

// ---------------------------------------------------------------------------
// Helpers puros del sync
// ---------------------------------------------------------------------------

/** jsonb → string[] saneado (no-strings y vacíos fuera). */
function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter(
        (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
}

/** `metadata.error` del clip cuando existe (jsonb puede traer cualquier cosa). */
function extractClipError(metadata: unknown): string | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
        return null;
    const err = (metadata as Record<string, unknown>).error;
    return typeof err === 'string' && err.trim().length > 0 ? err : null;
}

/** Título del asset flyer — derivado de la nota madre + índice. */
function flyerTitle(noteTitle: string | null, quoteIndex: number): string {
    const base = noteTitle?.trim() || 'Nota';
    return `${base} — flyer #${quoteIndex + 1}`;
}

// ---------------------------------------------------------------------------
// listAssets — lectura del ledger
// ---------------------------------------------------------------------------

export interface ListAssetsInput extends AssetListFilters {
    tenantId: string;
}

/** Lista los assets del tenant con filtros opcionales. */
export async function listAssets(
    input: ListAssetsInput,
    deps: AssetServiceDeps = {},
): Promise<AssetRow[]> {
    return resolveStore(deps).listAssets(input.tenantId, {
        kind: input.kind,
        status: input.status,
        transmissionId: input.transmissionId,
    });
}

// ---------------------------------------------------------------------------
// syncAssets — el CORAZÓN del ledger (pull desde clips/publications)
// ---------------------------------------------------------------------------

export interface SyncAssetsInput {
    tenantId: string;
    /** Si viene, sólo sincroniza los clips de esa transmisión (las notas no tienen transmission_id: se sincronizan todas igual). */
    transmissionId?: string;
}

export interface SyncAssetsResult {
    /** Total de upserts ejecutados (una corrida idempotente cuenta igual). */
    upserted: number;
    byKind: Record<AssetKind, number>;
}

/**
 * Recorre las fuentes y refleja cada artefacto en `assets`:
 *   - clip  (por clip del tenant, o de la transmisión): payload
 *           {videoPath, duration} + error de metadata cuando status='error';
 *           transmission_id desde el clip.
 *   - note  (por publication): payload {content}; sin transmission_id
 *           (publications no tiene la columna).
 *   - flyer (por cada path de quoteFlyerPaths[i]): ref_id = v5(pubId,i)
 *           determinista, parent_asset_id = asset de la nota, payload
 *           {flyerPath, quoteIndex}; status inicial = el canónico de la
 *           nota madre (después transiciona por su cuenta).
 *
 * Idempotente: la UNIQUE (tenant_id, source_table, ref_id) garantiza que
 * re-correr actualiza en vez de duplicar, y el conflicto preserva status
 * (un asset transicionado a mano no retrocede por un re-sync).
 */
export async function syncAssets(
    input: SyncAssetsInput,
    deps: AssetServiceDeps = {},
): Promise<SyncAssetsResult> {
    const store = resolveStore(deps);
    const byKind: Record<AssetKind, number> = {
        clip: 0,
        note: 0,
        flyer: 0,
        post: 0,
    };

    // ── Clips ──────────────────────────────────────────────────────────
    const clipRows = await store.listClips(
        input.tenantId,
        input.transmissionId,
    );
    for (const clip of clipRows) {
        const payload: Record<string, unknown> = {
            videoPath: clip.videoPath,
            duration: clip.duration,
        };
        if (clip.status === 'error') {
            const err = extractClipError(clip.metadata);
            if (err) payload.error = err;
        }
        await store.upsertAsset({
            tenantId: input.tenantId,
            kind: 'clip',
            sourceTable: 'clips',
            refId: clip.id,
            title: clip.title,
            status: mapLegacyStatus('clips', clip.status),
            payload,
            transmissionId: clip.transmissionId,
        });
        byKind.clip++;
    }

    // ── Publications (notas) + flyers ───────────────────────────────────
    const pubRows = await store.listPublications(input.tenantId);
    for (const pub of pubRows) {
        const noteStatus = mapLegacyStatus('publications', pub.status);
        const noteAsset = await store.upsertAsset({
            tenantId: input.tenantId,
            kind: 'note',
            sourceTable: 'publications',
            refId: pub.id,
            title: pub.title,
            status: noteStatus,
            payload: { content: pub.content },
            transmissionId: null,
        });
        byKind.note++;

        const flyerPaths = toStringArray(pub.quoteFlyerPaths);
        for (let i = 0; i < flyerPaths.length; i++) {
            await store.upsertAsset({
                tenantId: input.tenantId,
                kind: 'flyer',
                sourceTable: 'publications',
                refId: flyerRefId(pub.id, i),
                parentAssetId: noteAsset.id,
                title: flyerTitle(pub.title, i),
                status: noteStatus,
                payload: { flyerPath: flyerPaths[i], quoteIndex: i },
            });
            byKind.flyer++;
        }
    }

    return {
        upserted: byKind.clip + byKind.note + byKind.flyer + byKind.post,
        byKind,
    };
}

// ---------------------------------------------------------------------------
// transitionAsset — máquina de estados + write-through al legacy
// ---------------------------------------------------------------------------

export interface TransitionAssetInput {
    tenantId: string;
    assetId: string;
    /** Estado canónico destino (se valida contra ASSET_STATES). */
    to: string;
}

/**
 * Valida la arista con `canTransition` y aplica:
 *   1. setAssetStatus sobre el ledger.
 *   2. write-through: `toLegacyStatus(source_table, to)` → UPDATE del
 *      status legacy de la fila fuente (los consumers viejos siguen
 *      viendo su estado). `archived` → null → NO toca la fuente (sin
 *      legacy; archivar no es 'rejected'). Para flyers el write-through
 *      es no-op natural: su ref_id derivado no matchea ninguna fila.
 *
 * Errores: invalid_state (422, `to` fuera de ASSET_STATES),
 * asset_not_found (404), invalid_transition (409).
 */
export async function transitionAsset(
    input: TransitionAssetInput,
    deps: AssetServiceDeps = {},
): Promise<AssetRow> {
    const store = resolveStore(deps);

    if (!isAssetState(input.to)) {
        throw new AppError(
            `Estado canónico inválido: '${input.to}'. Válidos: ${ASSET_STATES.join(', ')}`,
            422,
            'invalid_state',
        );
    }

    const asset = await store.getAsset(input.assetId, input.tenantId);
    if (!asset) {
        throw new AppError('Asset no encontrado', 404, 'asset_not_found');
    }

    if (!canTransition(asset.status, input.to)) {
        throw new AppError(
            `Transición inválida: ${asset.status} → ${input.to}`,
            409,
            'invalid_transition',
        );
    }

    const updated = await store.setAssetStatus(
        input.assetId,
        input.tenantId,
        input.to,
    );
    if (!updated) {
        // Carrera: existía en el get y ya no — se reporta como 404.
        throw new AppError('Asset no encontrado', 404, 'asset_not_found');
    }

    const legacy = toLegacyStatus(asset.sourceTable, input.to);
    if (legacy !== null) {
        await store.updateSourceStatus(
            asset.sourceTable as AssetSourceTable,
            asset.refId,
            input.tenantId,
            legacy,
        );
    }

    return updated;
}
