/**
 * attributedQuotesService — citas atribuidas a persona (nombre + foto)
 * (PE-05).
 *
 * Las citas ya quedan persistidas por el motor de análisis (PE-02) en
 * `transmission_moments` con `kind='detected'`, `reason='quote'` y `title`
 * = texto de la cita. Este servicio las **atribuye computed-on-read**: NO
 * hay cambios de schema y NO se persiste la atribución —
 *
 *   cita → utterance de `transcript_segments` con MAYOR overlap temporal
 *   (misma transmisión; empate → la que contiene el punto medio de la
 *   cita) → `speaker_label` + `person_id` → `persons.name` + foto
 *   (`person_photos.is_primary`, fallback la más antigua — la misma regla
 *   que `liveRoomService`/`faceEnrollmentService.findPrimaryPhoto`).
 *
 * ¿Por qué computed-on-read? Una corrección manual de `person_id` (PE-03
 * `correctSpeakerPerson`) re-atribuye las citas automáticamente — si la
 * atribución estuviera persistida quedaría stale.
 *
 * `attribution` por cita:
 *   - 'person'        → la utterance elegida tiene `person_id`
 *   - 'speaker'       → sólo hay `speaker_label`
 *   - 'unattributed'  → no hay utterance solapada (o no aporta identidad)
 *
 * El `personPhotoUrl` replica el path ya establecido por liveRoomService:
 * `/api/persons/${personId}/photos/${photoId}` (la ruta GET existe en
 * `routes/persons.ts`). Sin endpoints ni socket: la Sala/UI lo consume.
 *
 * Patrón del repo: `AttributedQuotesStore` + impl drizzle + factory para
 * tests con store en memoria — TODA query filtra por `tenant_id`.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { transcriptSegments, transmissionMoments } from '../db/schema/live.js';
import { personPhotos, persons } from '../db/schema/persons.js';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Momento `reason='quote'` leído de `transmission_moments` (sólo lectura). */
export interface QuoteMoment {
  id: string;
  startMs: number;
  endMs: number;
  /** `title` del momento = texto de la cita. */
  text: string | null;
  reason: string | null;
  score: number | null;
}

/** Utterance de `transcript_segments` candidata a cubrir una cita. */
export interface QuoteUtterance {
  id: string;
  startMs: number;
  endMs: number;
  speakerLabel: string | null;
  personId: string | null;
}

/**
 * Persona referenciada por las utterances elegidas, con su foto ya
 * resuelta: la primaria si existe; si no, la más antigua (`created_at`
 * ASC) — la misma regla que `faceEnrollmentService.findPrimaryPhoto`.
 * `primaryPhotoId` null = persona sin fotos.
 */
export interface QuotePersonRef {
  personId: string;
  name: string;
  primaryPhotoId: string | null;
}

export type QuoteAttribution = 'person' | 'speaker' | 'unattributed';

export interface AttributedQuote {
  momentId: string;
  text: string | null;
  startMs: number;
  endMs: number;
  /** `score`/`reason` del momento detected, si aplican (quotes: null/'quote'). */
  score: number | null;
  reason: string | null;
  speakerLabel: string | null;
  personId: string | null;
  personName: string | null;
  personPhotoUrl: string | null;
  attribution: QuoteAttribution;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface AttributedQuotesStore {
  /** Momentos `kind='detected' AND reason='quote'` ordenados por `start_ms`. */
  listQuoteMoments(
    tenantId: string,
    transmissionId: string,
  ): Promise<QuoteMoment[]>;
  /** Utterances de la transmisión ordenadas por `start_ms`. */
  listUtterances(
    tenantId: string,
    transmissionId: string,
  ): Promise<QuoteUtterance[]>;
  /**
   * `{personId, name, primaryPhotoId}` de las personas pedidas — una
   * query; la foto es la primaria o, en su defecto, la más antigua.
   */
  listPersonsPhotos(
    tenantId: string,
    personIds: string[],
  ): Promise<QuotePersonRef[]>;
}

/** Implementación drizzle — todas las queries filtran por tenant_id. */
export function createDrizzleAttributedQuotesStore(
  executor: Database = db,
): AttributedQuotesStore {
  return {
    async listQuoteMoments(tenantId, transmissionId) {
      return executor
        .select({
          id: transmissionMoments.id,
          startMs: transmissionMoments.startMs,
          endMs: transmissionMoments.endMs,
          text: transmissionMoments.title,
          reason: transmissionMoments.reason,
          score: transmissionMoments.score,
        })
        .from(transmissionMoments)
        .where(
          and(
            eq(transmissionMoments.tenantId, tenantId),
            eq(transmissionMoments.transmissionId, transmissionId),
            eq(transmissionMoments.kind, 'detected'),
            eq(transmissionMoments.reason, 'quote'),
          ),
        )
        .orderBy(asc(transmissionMoments.startMs));
    },

    async listUtterances(tenantId, transmissionId) {
      return executor
        .select({
          id: transcriptSegments.id,
          startMs: transcriptSegments.startMs,
          endMs: transcriptSegments.endMs,
          speakerLabel: transcriptSegments.speakerLabel,
          personId: transcriptSegments.personId,
        })
        .from(transcriptSegments)
        .where(
          and(
            eq(transcriptSegments.tenantId, tenantId),
            eq(transcriptSegments.transmissionId, transmissionId),
          ),
        )
        .orderBy(asc(transcriptSegments.startMs));
    },

    async listPersonsPhotos(tenantId, personIds) {
      if (personIds.length === 0) return [];
      // Una sola query: subquery correlacionada elige la foto primaria o,
      // en su defecto, la más antigua (is_primary DESC, created_at ASC).
      return executor
        .select({
          personId: persons.id,
          name: persons.name,
          primaryPhotoId: sql<string | null>`(
            select ${personPhotos.id}
            from ${personPhotos}
            where ${personPhotos.personId} = ${persons.id}
              and ${personPhotos.tenantId} = ${tenantId}
            order by ${personPhotos.isPrimary} desc, ${personPhotos.createdAt} asc
            limit 1
          )`,
        })
        .from(persons)
        .where(
          and(
            eq(persons.tenantId, tenantId),
            inArray(persons.id, personIds),
          ),
        );
    },
  };
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

/** Mismo formato de URL que `liveRoomService.personPhotoUrl`. */
function personPhotoUrl(personId: string, photoId: string | null): string | null {
  return photoId ? `/api/persons/${personId}/photos/${photoId}` : null;
}

/**
 * Devuelve la utterance de MAYOR overlap temporal con la ventana de la
 * cita (sólo candidatas con overlap > 0). Empate → la que contiene el
 * punto medio `[startMs, endMs)` de la cita; si el empate persiste, la
 * primera por `start_ms` (la lista viene ordenada — determinista).
 */
export function pickCoveringUtterance(
  quote: { startMs: number; endMs: number },
  utterances: QuoteUtterance[],
): QuoteUtterance | null {
  const mid = quote.startMs + (quote.endMs - quote.startMs) / 2;
  const containsMid = (u: QuoteUtterance) => u.startMs <= mid && mid < u.endMs;

  let best: QuoteUtterance | null = null;
  let bestOverlap = 0;
  for (const u of utterances) {
    const overlap =
      Math.min(quote.endMs, u.endMs) - Math.max(quote.startMs, u.startMs);
    if (overlap <= 0) continue;
    if (
      best === null ||
      overlap > bestOverlap ||
      // Empate: sólo se reemplaza si la candidata contiene el punto medio
      // y la ganadora actual no (si no, gana la primera — la más temprana).
      (overlap === bestOverlap && containsMid(u) && !containsMid(best))
    ) {
      best = u;
      bestOverlap = overlap;
    }
  }
  return best;
}

export function createAttributedQuotesService(
  store: AttributedQuotesStore = createDrizzleAttributedQuotesStore(),
) {
  /**
   * Citas de una transmisión con su atribución resuelta al leer —
   * ordenadas por `start_ms` del momento. Nunca escribe: una corrección
   * de `person_id` en `transcript_segments` se refleja en la próxima
   * lectura.
   */
  async function listAttributedQuotes(
    tenantId: string,
    transmissionId: string,
  ): Promise<AttributedQuote[]> {
    const moments = await store.listQuoteMoments(tenantId, transmissionId);
    if (!moments.length) return [];

    const utterances = await store.listUtterances(tenantId, transmissionId);

    const chosen = moments.map((moment) => ({
      moment,
      utterance: pickCoveringUtterance(moment, utterances),
    }));

    const personIds = [
      ...new Set(
        chosen
          .map((c) => c.utterance?.personId)
          .filter((id): id is string => id != null),
      ),
    ];
    const personRows = await store.listPersonsPhotos(tenantId, personIds);
    const personById = new Map(personRows.map((p) => [p.personId, p]));

    return chosen.map(({ moment, utterance }) => {
      const personId = utterance?.personId ?? null;
      const speakerLabel = utterance?.speakerLabel ?? null;
      const person = personId ? personById.get(personId) : undefined;
      const attribution: QuoteAttribution = personId
        ? 'person'
        : speakerLabel
          ? 'speaker'
          : 'unattributed';

      return {
        momentId: moment.id,
        text: moment.text,
        startMs: moment.startMs,
        endMs: moment.endMs,
        score: moment.score,
        reason: moment.reason,
        speakerLabel,
        personId,
        personName: person?.name ?? null,
        personPhotoUrl: person
          ? personPhotoUrl(person.personId, person.primaryPhotoId)
          : null,
        attribution,
      };
    });
  }

  return { listAttributedQuotes };
}

export const attributedQuotesService = createAttributedQuotesService();
