/**
 * rawRetentionService — retención del crudo por plan + purga (PD-06).
 *
 * El crudo (segmentos MP4 bajo `stream_recordings.storage_prefix`) se conserva
 * `plans.raw_retention_days` días desde `transmissions.ended_at`. Vencido ese
 * plazo, `purgeExpiredRecordings` borra los ARCHIVOS con
 * `RawStorage.deletePrefix` (nunca `fs` directo: el adapter sanea path
 * traversal) y marca los `recording_segments` como `purged`. Los metadatos
 * SOBREVIVEN: ni `stream_recordings`, ni `recording_segments`, ni la fila
 * `transmissions` se borran — sólo `transmissions.crudo_ref` queda en NULL
 * (el crudo ya no existe; dejar el ref sería mentir). Los `clips` y demás
 * assets derivados NUNCA se tocan.
 *
 * Decisiones documentadas:
 *   - `raw_retention_days = NULL` o `0` → SIN LÍMITE (no se purga). El 0
 *     literal borraría todo al día siguiente de emitir: se interpreta como
 *     "sin retención configurada", no como "borrar ya". Un valor negativo
 *     (dato corrupto) también equivale a sin límite.
 *   - Tenant sin suscripción o sin plan → `retentionDays: null` → no se
 *     purga NUNCA su material (la decisión segura).
 *   - Candidata = `stream_recordings.status='completed'` + transmisión con
 *     `ended_at` + `ended_at + retention_days < now` (estricto: terminada
 *     hace EXACTAMENTE N días todavía está dentro de la retención) + al
 *     menos UN segmento en estado distinto de `purged` (si todos están
 *     `purged`, la grabación ya está purgada → idempotencia del job).
 *   - `stream_recordings.status` queda `completed` tras purgar: la fila es
 *     el historial de la captura; el estado "sin crudo" lo expresan sus
 *     segmentos `purged` + `crudo_ref` NULL. No se inventa un estado nuevo.
 *   - Render pendiente: la purga se SALTEA (no se borra nada) si existe un
 *     clip en estado no terminal (`generating` — el único estado donde el
 *     render sigue en vuelo; `pending_review` ya tiene video) que referencie
 *     la transmisión. `clips` no tiene FK a transmissions, así que la
 *     referencia se evalúa por DOS vías: (a) `clips.metadata->>'transmissionId'`
 *     — contrato explícito para el subsistema de clips: quien renderiza desde
 *     un crudo registra su transmissionId en metadata; (b) heurística
 *     `clips.program_id = transmissions.program_id` con `clips.created_at`
 *     dentro de la ventana del crudo [started_at, ended_at + 24 h] — un clip
 *     generándose sobre el material de ESA transmisión.
 *   - `job_executions` (tabla legacy de jobs) se revisó como fuente de
 *     renders pendientes: referencia `scheduled_jobs`, no transmissions —
 *     no puede apuntar a un crudo. Los renders que produce aparecen como
 *     filas `clips` en `generating`, ya cubiertos por el chequeo anterior.
 *   - Toda escritura filtra por `tenant_id` (regla dura del repo) aunque el
 *     job sea global: UPDATE de segmentos y de `crudo_ref` llevan
 *     `WHERE tenant_id`. `opts.tenantId` acota el scan para la purga manual
 *     del endpoint (un tenant sólo purga lo suyo).
 *   - Orden de la purga por candidata: deletePrefix → tx(marcar segmentos
 *     `purged` + `crudo_ref` NULL). Si la tx falla tras borrar archivos, el
 *     próximo run reintenta: deletePrefix es `rm -rf` idempotente y los
 *     segmentos seguían sin `purged` → sigue siendo candidata.
 *   - Una falla NO aborta el job: el error va a `PurgeOutcome.errors[]` y
 *     se sigue con la candidata siguiente.
 *
 * Dependencias inyectables (`deps`): `RetentionStore` (drizzle en prod,
 * memoria en tests — mismos filtros por tenant) y `RawStorage` (filesystem
 * real o fake que registra llamadas).
 */
import { and, asc, count, eq, gt, gte, inArray, isNotNull, lte, ne, or, sql } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { plans, subscriptions } from '../db/schema/billing.js';
import { clips } from '../db/schema/clips.js';
import { recordingSegments, streamRecordings } from '../db/schema/recordings.js';
import { transmissions } from '../db/schema/transmissions.js';
import { getRawStorage, type RawStorage } from './rawStorageService.js';

// ─── API pública ────────────────────────────────────────────────────────────

export interface RetentionPolicy {
  tenantId: string;
  /** Días de retención del crudo. null = sin límite (no purgar). */
  retentionDays: number | null;
}

export interface PurgeCandidate {
  recordingId: string;
  tenantId: string;
  storagePrefix: string;
  /** Instante de fin de la transmisión (ancla de la retención). */
  endedAt: Date;
  daysOverdue: number;
}

export interface PurgeOutcome {
  scanned: number;
  purged: number;
  skipped: number;
  bytesFreed: number;
  errors: Array<{ recordingId: string; message: string }>;
}

/** Fila completa que el store resuelve para una candidata (superset del DTO). */
export interface ExpiredRecordingRow {
  recordingId: string;
  tenantId: string;
  transmissionId: string;
  storagePrefix: string;
  totalBytes: number;
  endedAt: Date;
  /** `transmissions.started_at` — ancla inferior de la ventana del render. */
  startedAt: Date | null;
  /** `transmissions.program_id` — para la heurística clip↔transmisión. */
  programId: string | null;
  /** Retención efectiva del tenant en días (> 0 — resuelta por el store). */
  retentionDays: number;
}

export interface RetentionStore {
  /** `plans.raw_retention_days` del tenant (null = sin plan/sub/límite). */
  findRawRetentionDays(tenantId: string): Promise<number | null>;
  /**
   * Grabaciones vencidas según la retención de SU tenant (ya resuelta por
   * fila). `tenantId` opcional acota el scan; `limit` corta el lote para
   * que el job no bloquee la DB.
   */
  listExpiredCandidates(
    now: Date,
    opts: { limit: number; tenantId?: string },
  ): Promise<ExpiredRecordingRow[]>;
  /**
   * ¿Hay un render de clip en vuelo que referencia esta grabación?
   * Implementación: clips en estado no terminal del MISMO tenant cuyo
   * `metadata.transmissionId` sea la transmisión o cuyo `program_id`
   * coincida con el de la transmisión dentro de la ventana del crudo.
   */
  hasPendingRender(candidate: ExpiredRecordingRow): Promise<boolean>;
  /**
   * Marca los segmentos `purged` y libera `transmissions.crudo_ref` en una
   * sola transacción, TODO acotado por `tenant_id`. No borra filas.
   */
  finalizePurge(
    tenantId: string,
    recordingId: string,
    transmissionId: string,
  ): Promise<void>;
}

export interface RetentionDeps {
  store?: RetentionStore;
  storage?: RawStorage;
}

// ─── Constantes ─────────────────────────────────────────────────────────────

/** Lote máximo por corrida del job — la purga no bloquea la DB de una vez. */
export const DEFAULT_PURGE_LIMIT = 100;

/** Estados de `clips` en los que el render SIGUE en vuelo (no terminales). */
export const NON_TERMINAL_CLIP_STATUSES = ['generating'] as const;

/** Holgura post-`ended_at` para la ventana clip↔transmisión (renders al cierre). */
const RENDER_WINDOW_GRACE_MS = 24 * 60 * 60 * 1000;

const MS_PER_DAY = 86_400_000;

// ─── Implementación drizzle del store ───────────────────────────────────────

/** Implementación drizzle — las escrituras siempre filtran `tenant_id`. */
export function createDrizzleRetentionStore(
  executor: Database = db,
): RetentionStore {
  return {
    async findRawRetentionDays(tenantId) {
      const [row] = await executor
        .select({ days: plans.rawRetentionDays })
        .from(subscriptions)
        .leftJoin(plans, eq(subscriptions.planId, plans.id))
        .where(eq(subscriptions.tenantId, tenantId))
        .limit(1);
      return row?.days ?? null;
    },

    async listExpiredCandidates(now, opts) {
      const rows = await executor
        .select({
          recordingId: streamRecordings.id,
          tenantId: streamRecordings.tenantId,
          transmissionId: streamRecordings.transmissionId,
          storagePrefix: streamRecordings.storagePrefix,
          totalBytes: streamRecordings.totalBytes,
          endedAt: transmissions.endedAt,
          startedAt: transmissions.startedAt,
          programId: transmissions.programId,
          retentionDays: plans.rawRetentionDays,
        })
        .from(streamRecordings)
        .innerJoin(
          transmissions,
          eq(streamRecordings.transmissionId, transmissions.id),
        )
        // INNER JOIN: sin suscripción o sin plan no hay retención definida →
        // nunca candidatas (la decisión segura del header).
        .innerJoin(
          subscriptions,
          eq(subscriptions.tenantId, streamRecordings.tenantId),
        )
        .innerJoin(plans, eq(subscriptions.planId, plans.id))
        .where(
          and(
            // Nunca una captura en curso (`recording`) ni fallida (`error`).
            eq(streamRecordings.status, 'completed'),
            isNotNull(transmissions.endedAt),
            // NULL y 0 → sin límite → excluidas (interpretación documentada).
            gt(plans.rawRetentionDays, 0),
            // ended_at + retention > now ⇒ todavía dentro del plazo. La
            // desigualdad es ESTRICTA: exactamente N días no es candidata.
            sql`${transmissions.endedAt} + (${plans.rawRetentionDays} * interval '1 day') < ${now}`,
            // Idempotencia: ya purgada = ningún segmento sin `purged`.
            sql`exists (
                  select 1 from recording_segments s
                  where s.recording_id = ${streamRecordings.id}
                    and s.status <> 'purged'
                )`,
            opts.tenantId
              ? eq(streamRecordings.tenantId, opts.tenantId)
              : undefined,
          ),
        )
        .orderBy(asc(transmissions.endedAt)) // lo más viejo se purga primero
        .limit(opts.limit);

      return rows.map((r) => ({
        recordingId: r.recordingId,
        tenantId: r.tenantId,
        transmissionId: r.transmissionId,
        storagePrefix: r.storagePrefix,
        totalBytes: r.totalBytes,
        endedAt: r.endedAt as Date,
        startedAt: r.startedAt,
        programId: r.programId,
        retentionDays: r.retentionDays as number,
      }));
    },

    async hasPendingRender(candidate) {
      // Ventana del crudo: [started_at (fallback ended_at), ended_at + 24 h].
      const windowStart = candidate.startedAt ?? candidate.endedAt;
      const windowEnd = new Date(candidate.endedAt.getTime() + RENDER_WINDOW_GRACE_MS);

      const metadataRef = sql`${clips.metadata} ->> 'transmissionId' = ${candidate.transmissionId}`;
      const programRef = candidate.programId
        ? and(
            eq(clips.programId, candidate.programId),
            gte(clips.createdAt, windowStart),
            lte(clips.createdAt, windowEnd),
          )
        : undefined;

      const [row] = await executor
        .select({ n: count() })
        .from(clips)
        .where(
          and(
            eq(clips.tenantId, candidate.tenantId),
            inArray(clips.status, [...NON_TERMINAL_CLIP_STATUSES]),
            programRef ? or(metadataRef, programRef) : metadataRef,
          ),
        );
      return (row?.n ?? 0) > 0;
    },

    async finalizePurge(tenantId, recordingId, transmissionId) {
      await executor.transaction(async (tx) => {
        // Segmentos marcados, NUNCA borrados: son el metadato del crudo.
        await tx
          .update(recordingSegments)
          .set({ status: 'purged' })
          .where(
            and(
              eq(recordingSegments.recordingId, recordingId),
              eq(recordingSegments.tenantId, tenantId),
              // Idempotente: re-purgar no toca lo ya purgado.
              ne(recordingSegments.status, 'purged'),
            ),
          );
        // crudo_ref a NULL: el crudo ya no existe, la fila sobrevive.
        await tx
          .update(transmissions)
          .set({ crudoRef: null })
          .where(
            and(
              eq(transmissions.id, transmissionId),
              eq(transmissions.tenantId, tenantId),
            ),
          );
      });
    },
  };
}

// ─── Funciones del servicio ─────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolveDeps(deps: RetentionDeps): Required<RetentionDeps> {
  return {
    store: deps.store ?? createDrizzleRetentionStore(),
    storage: deps.storage ?? getRawStorage(),
  };
}

/** Días de retención efectivos del tenant (según su plan). null = ilimitado. */
export async function getRetentionPolicy(
  tenantId: string,
  deps: RetentionDeps = {},
): Promise<RetentionPolicy> {
  const store = deps.store ?? createDrizzleRetentionStore();
  const raw = await store.findRawRetentionDays(tenantId);
  // 0 / NULL / negativo → sin límite (documentado en el header).
  return {
    tenantId,
    retentionDays: raw !== null && raw > 0 ? raw : null,
  };
}

/**
 * Grabaciones cuyo crudo venció la retención. `now` inyectable para tests.
 * `opts.tenantId` (opcional) acota el scan — es el modo del endpoint manual.
 */
export async function findExpiredRecordings(
  now: Date,
  opts: { limit?: number; tenantId?: string } = {},
  deps: RetentionDeps = {},
): Promise<PurgeCandidate[]> {
  const store = deps.store ?? createDrizzleRetentionStore();
  const rows = await store.listExpiredCandidates(now, {
    limit: opts.limit ?? DEFAULT_PURGE_LIMIT,
    tenantId: opts.tenantId,
  });
  return rows.map((r) => ({
    recordingId: r.recordingId,
    tenantId: r.tenantId,
    storagePrefix: r.storagePrefix,
    endedAt: r.endedAt,
    daysOverdue:
      Math.floor((now.getTime() - r.endedAt.getTime()) / MS_PER_DAY) -
      r.retentionDays,
  }));
}

/**
 * Borra el crudo vencido: archivos del storage + segmentos `purged` +
 * `crudo_ref` NULL. Una candidata con render pendiente cuenta como `skipped`
 * (el render completa primero). Con `dryRun` no se toca storage ni filas —
 * devuelve lo que la corrida HARÍA (preview del panel/tests).
 */
export async function purgeExpiredRecordings(
  now: Date,
  opts: { limit?: number; dryRun?: boolean; tenantId?: string } = {},
  deps: RetentionDeps = {},
): Promise<PurgeOutcome> {
  const { store, storage } = resolveDeps(deps);
  const outcome: PurgeOutcome = {
    scanned: 0,
    purged: 0,
    skipped: 0,
    bytesFreed: 0,
    errors: [],
  };

  const rows = await store.listExpiredCandidates(now, {
    limit: opts.limit ?? DEFAULT_PURGE_LIMIT,
    tenantId: opts.tenantId,
  });
  outcome.scanned = rows.length;

  for (const row of rows) {
    try {
      // Render en vuelo sobre este crudo → no se borra NADA: se saltea.
      if (await store.hasPendingRender(row)) {
        outcome.skipped++;
        continue;
      }
      if (!opts.dryRun) {
        await storage.deletePrefix(row.storagePrefix);
        await store.finalizePurge(row.tenantId, row.recordingId, row.transmissionId);
      }
      outcome.purged++;
      outcome.bytesFreed += row.totalBytes;
    } catch (err) {
      // Una falla no aborta el job: se registra y se sigue.
      outcome.errors.push({ recordingId: row.recordingId, message: errorMessage(err) });
    }
  }

  return outcome;
}

/** Etiqueta legible de la política, p.ej. "30 días" o "sin límite". */
export function describeRetention(policy: RetentionPolicy): string {
  if (policy.retentionDays === null) return 'sin límite';
  return `${policy.retentionDays} ${policy.retentionDays === 1 ? 'día' : 'días'}`;
}
