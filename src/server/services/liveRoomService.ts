/**
 * liveRoomService — estado y acciones de la Sala "En vivo" (PD-05).
 *
 * Fuentes de verdad de cada bloque del payload:
 *
 *   - transmission → `transmissions` + `programs` (programName).
 *   - recording    → `stream_recordings` (1-a-1 por transmisión) +
 *                    `recording_segments`.
 *   - timeline     → `transcript_segments` (tabla PD-05): utterances con
 *                    offsets relativos a `transmissions.started_at`. La
 *                    atribución se resuelve contra `persons` por `person_id`;
 *                    sin atribución viaja `personId: null` y el label
 *                    genérico — degradado, nunca error.
 *   - moments      → `transmission_moments` (tabla PD-05). Hoy la alimenta el
 *                    mark manual del editor; la Épica E (motor de análisis)
 *                    insertará `kind='detected'` con `score`/`reason`.
 *   - clips        → `clips` filtrados por `transmission_id` (columna PD-05).
 *   - people       → personas distintas que aparecen en `transcript_segments`
 *                    con `person_id` resuelto, con su foto primaria
 *                    (`person_photos`) y la mejor confianza observada.
 *
 * Reglas duras: TODA query filtra por `tenant_id` (+ id del recurso). Una
 * transmisión de otro tenant es indistinguible de una inexistente → el
 * caller responde 404.
 *
 * Dependencias inyectables (`deps`): executor drizzle, store completo y
 * reloj — los tests corren sobre stores en memoria.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { transmissions } from '../db/schema/transmissions.js';
import { programs } from '../db/schema/programs.js';
import { streamRecordings, recordingSegments } from '../db/schema/recordings.js';
import { transcriptSegments, transmissionMoments } from '../db/schema/live.js';
import { clips } from '../db/schema/clips.js';
import { persons, personPhotos } from '../db/schema/persons.js';
import type { TransmissionRow } from './transmissionService.js';
import type {
    LiveRoomClip,
    LiveRoomMoment,
    LiveRoomPerson,
    LiveRoomState,
    LiveRoomTimelineItem,
} from '../../shared/types.js';

// ─── Tipos del payload de la sala ─────────────────────────────────────────────
// Definidos en src/shared/types.ts (contrato único API↔cliente). Se re-exportan
// para que consumidores del servicio no cambien de import.
export type {
    LiveRoomClip,
    LiveRoomMoment,
    LiveRoomPerson,
    LiveRoomRecording,
    LiveRoomSegment,
    LiveRoomState,
    LiveRoomTimelineItem,
    LiveRoomTransmission,
} from '../../shared/types.js';

// ─── Store (drizzle + inyectable para tests) ──────────────────────────────────

export type TranscriptSegmentRow = typeof transcriptSegments.$inferSelect;
export type TransmissionMomentRow = typeof transmissionMoments.$inferSelect;
export type ClipRow = typeof clips.$inferSelect;
export type StreamRecordingRow = typeof streamRecordings.$inferSelect;
export type RecordingSegmentRow = typeof recordingSegments.$inferSelect;

export interface PersonRef {
    id: string;
    name: string;
    primaryPhotoId: string | null;
}

/** Store de la sala — TODA operación filtra por tenant_id. */
export interface LiveRoomStore {
    findTransmission(
        tenantId: string,
        transmissionId: string,
    ): Promise<TransmissionRow | null>;
    programName(tenantId: string, programId: string): Promise<string | null>;
    findRecording(
        tenantId: string,
        transmissionId: string,
    ): Promise<StreamRecordingRow | null>;
    listRecordingSegments(
        tenantId: string,
        recordingId: string,
    ): Promise<RecordingSegmentRow[]>;
    listTranscriptSegments(
        tenantId: string,
        transmissionId: string,
    ): Promise<TranscriptSegmentRow[]>;
    listMoments(
        tenantId: string,
        transmissionId: string,
    ): Promise<TransmissionMomentRow[]>;
    listClips(tenantId: string, transmissionId: string): Promise<ClipRow[]>;
    /** Personas referenciadas por los `personId` dados, tenant-scoped. */
    findPersons(tenantId: string, personIds: string[]): Promise<PersonRef[]>;
    insertMoment(v: {
        tenantId: string;
        transmissionId: string;
        kind: string;
        startMs: number;
        endMs: number;
        title: string | null;
        reason: string | null;
        score: number | null;
        clipId: string | null;
    }): Promise<TransmissionMomentRow>;
    insertClip(v: {
        tenantId: string;
        transmissionId: string;
        programId: string | null;
        title: string;
        hookText: string;
        duration: number;
        status: string;
        metadata: Record<string, unknown>;
    }): Promise<ClipRow>;
}

/** Implementación drizzle — todas las queries filtran por tenant_id. */
export function createDrizzleLiveRoomStore(
    executor: Database = db,
): LiveRoomStore {
    return {
        async findTransmission(tenantId, transmissionId) {
            const [row] = await executor
                .select()
                .from(transmissions)
                .where(
                    and(
                        eq(transmissions.id, transmissionId),
                        eq(transmissions.tenantId, tenantId),
                    ),
                )
                .limit(1);
            return row ?? null;
        },

        async programName(tenantId, programId) {
            const [row] = await executor
                .select({ name: programs.name })
                .from(programs)
                .where(
                    and(
                        eq(programs.id, programId),
                        eq(programs.tenantId, tenantId),
                    ),
                )
                .limit(1);
            return row?.name ?? null;
        },

        async findRecording(tenantId, transmissionId) {
            const [row] = await executor
                .select()
                .from(streamRecordings)
                .where(
                    and(
                        eq(streamRecordings.transmissionId, transmissionId),
                        eq(streamRecordings.tenantId, tenantId),
                    ),
                )
                .limit(1);
            return row ?? null;
        },

        async listRecordingSegments(tenantId, recordingId) {
            return executor
                .select()
                .from(recordingSegments)
                .where(
                    and(
                        eq(recordingSegments.recordingId, recordingId),
                        eq(recordingSegments.tenantId, tenantId),
                    ),
                )
                .orderBy(asc(recordingSegments.sequence));
        },

        async listTranscriptSegments(tenantId, transmissionId) {
            return executor
                .select()
                .from(transcriptSegments)
                .where(
                    and(
                        eq(transcriptSegments.transmissionId, transmissionId),
                        eq(transcriptSegments.tenantId, tenantId),
                    ),
                )
                .orderBy(asc(transcriptSegments.startMs));
        },

        async listMoments(tenantId, transmissionId) {
            return executor
                .select()
                .from(transmissionMoments)
                .where(
                    and(
                        eq(transmissionMoments.transmissionId, transmissionId),
                        eq(transmissionMoments.tenantId, tenantId),
                    ),
                )
                .orderBy(asc(transmissionMoments.startMs));
        },

        async listClips(tenantId, transmissionId) {
            return executor
                .select()
                .from(clips)
                .where(
                    and(
                        eq(clips.transmissionId, transmissionId),
                        eq(clips.tenantId, tenantId),
                    ),
                )
                .orderBy(desc(clips.createdAt));
        },

        async findPersons(tenantId, personIds) {
            if (personIds.length === 0) return [];
            const [personRows, photoRows] = await Promise.all([
                executor
                    .select({ id: persons.id, name: persons.name })
                    .from(persons)
                    .where(
                        and(
                            eq(persons.tenantId, tenantId),
                            inArray(persons.id, personIds),
                        ),
                    ),
                executor
                    .select({
                        personId: personPhotos.personId,
                        id: personPhotos.id,
                        isPrimary: personPhotos.isPrimary,
                    })
                    .from(personPhotos)
                    .where(
                        and(
                            eq(personPhotos.tenantId, tenantId),
                            inArray(personPhotos.personId, personIds),
                        ),
                    ),
            ]);

            // Foto: la primaria si existe; si no, la primera del lote.
            const photoByPerson = new Map<string, string>();
            for (const p of photoRows) {
                const current = photoByPerson.get(p.personId);
                if (!current || p.isPrimary) photoByPerson.set(p.personId, p.id);
            }
            return personRows.map((p) => ({
                id: p.id,
                name: p.name,
                primaryPhotoId: photoByPerson.get(p.id) ?? null,
            }));
        },

        async insertMoment(v) {
            const [row] = await executor
                .insert(transmissionMoments)
                .values(v)
                .returning();
            return row;
        },

        async insertClip(v) {
            const [row] = await executor
                .insert(clips)
                .values({
                    tenantId: v.tenantId,
                    transmissionId: v.transmissionId,
                    programId: v.programId,
                    title: v.title,
                    hookText: v.hookText,
                    duration: v.duration,
                    status: v.status,
                    metadata: v.metadata,
                })
                .returning();
            return row;
        },
    };
}

// ─── Serialización ────────────────────────────────────────────────────────────

function serializeMoment(row: TransmissionMomentRow): LiveRoomMoment {
    return {
        id: row.id,
        kind: row.kind,
        startMs: row.startMs,
        endMs: row.endMs,
        title: row.title,
        reason: row.reason,
        score: row.score,
        clipId: row.clipId,
    };
}

function serializeClip(row: ClipRow): LiveRoomClip {
    return {
        id: row.id,
        title: row.title,
        hookText: row.hookText,
        status: row.status,
        duration: row.duration,
        // El endpoint /api/clips/:id/video (PD-07) es el que sirve el MP4.
        videoUrl: row.videoPath ? `/api/clips/${row.id}/video` : null,
    };
}

function personPhotoUrl(personId: string, photoId: string | null): string | null {
    return photoId ? `/api/persons/${personId}/photos/${photoId}` : null;
}

// ─── Caso de uso: estado completo de la sala ──────────────────────────────────

export interface LiveRoomDeps {
    store?: LiveRoomStore;
}

/**
 * Devuelve el payload completo de la sala o null si la transmisión no es del
 * tenant (el caller traduce a 404 — nunca se distingue "de otro" de
 * "inexistente").
 */
export async function getLiveRoomState(
    tenantId: string,
    transmissionId: string,
    deps: LiveRoomDeps = {},
): Promise<LiveRoomState | null> {
    const store = deps.store ?? createDrizzleLiveRoomStore();

    const transmission = await store.findTransmission(tenantId, transmissionId);
    if (!transmission) return null;

    const [recording, timelineRows, momentRows, clipRows, programName] =
        await Promise.all([
            store.findRecording(tenantId, transmissionId),
            store.listTranscriptSegments(tenantId, transmissionId),
            store.listMoments(tenantId, transmissionId),
            store.listClips(tenantId, transmissionId),
            transmission.programId
                ? store.programName(tenantId, transmission.programId)
                : Promise.resolve(null),
        ]);

    const segments = recording
        ? await store.listRecordingSegments(tenantId, recording.id)
        : [];

    // Personas referenciadas por el timeline (atribuidas).
    const personIds = [
        ...new Set(
            timelineRows
                .map((s) => s.personId)
                .filter((id): id is string => id !== null),
        ),
    ];
    const personRefs = await store.findPersons(tenantId, personIds);
    const personById = new Map(personRefs.map((p) => [p.id, p]));

    const timeline: LiveRoomTimelineItem[] = timelineRows.map((s) => {
        const person = s.personId ? personById.get(s.personId) : undefined;
        return {
            id: s.id,
            startMs: s.startMs,
            endMs: s.endMs,
            speakerLabel: s.speakerLabel,
            personId: s.personId,
            personName: person?.name ?? null,
            personPhotoUrl: person ? personPhotoUrl(person.id, person.primaryPhotoId) : null,
            text: s.text,
            confidence: s.confidence,
        };
    });

    // Panel de personas detectadas: una entrada por person_id con su mejor
    // confianza y el speaker label más reciente observado.
    const peopleByPerson = new Map<string, LiveRoomPerson>();
    for (const s of timelineRows) {
        if (!s.personId) continue;
        const person = personById.get(s.personId);
        if (!person) continue;
        const prev = peopleByPerson.get(s.personId);
        peopleByPerson.set(s.personId, {
            personId: s.personId,
            name: person.name,
            photoUrl: personPhotoUrl(person.id, person.primaryPhotoId),
            confidence:
                prev?.confidence != null && s.confidence != null
                    ? Math.max(prev.confidence, s.confidence)
                    : (s.confidence ?? prev?.confidence ?? null),
            speakerLabel: s.speakerLabel ?? prev?.speakerLabel ?? null,
        });
    }

    return {
        transmission: {
            id: transmission.id,
            status: transmission.status,
            source: transmission.source,
            streamUrl: transmission.streamUrl,
            crudoRef: transmission.crudoRef,
            startedAt: transmission.startedAt?.toISOString() ?? null,
            endedAt: transmission.endedAt?.toISOString() ?? null,
            durationMinutes: transmission.durationMinutes,
            errorMessage: transmission.errorMessage,
            programId: transmission.programId,
            programName,
        },
        recording: recording
            ? {
                  id: recording.id,
                  status: recording.status,
                  segmentCount: segments.length,
                  totalBytes: recording.totalBytes,
                  startedAt: recording.startedAt?.toISOString() ?? null,
                  endedAt: recording.endedAt?.toISOString() ?? null,
              }
            : null,
        segments: segments.map((s) => ({
            sequence: s.sequence,
            startMs: s.startMs,
            endMs: s.endMs,
            bytes: s.bytes,
            status: s.status,
        })),
        timeline,
        moments: momentRows.map(serializeMoment),
        clips: clipRows.map(serializeClip),
        people: [...peopleByPerson.values()],
    };
}

// ─── Caso de uso: mark manual ─────────────────────────────────────────────────

export const MARK_TYPES = ['clip', 'note'] as const;
export type MarkType = (typeof MARK_TYPES)[number];

export const DEFAULT_MARK_WINDOW_SECONDS = 30;
export const MAX_MARK_WINDOW_SECONDS = 600;

export interface ManualMarkInput {
    tenantId: string;
    transmissionId: string;
    type: MarkType;
    /** Ventana hacia atrás en segundos (sólo `type='clip'`). */
    windowSeconds?: number;
    /** Título de la nota (sólo `type='note'`). */
    title?: string;
}

export interface ManualMarkResult {
    moment: LiveRoomMoment;
    clip: LiveRoomClip | null;
}

export interface ManualMarkDeps extends LiveRoomDeps {
    now?: () => Date;
}

/**
 * Registra el mark del editor sobre el eje temporal de la transmisión
 * (offsets relativos a `started_at`, misma convención que los segmentos).
 *
 *   - `type='clip'` → momento `kind='mark'` con `reason='mark manual'` + un
 *     clip en `generating` con la ventana en `metadata`, vinculado por
 *     `clip_id`. El render real queda a cargo del worker de clips:
 *     TODO (Épica E): encolar `generateClipVideo`/`createClip` cuando el
 *     pipeline de clips de transmisión exista — hoy `clipService` renderiza
 *     desde MP3 sueltos, no desde `recording_segments`.
 *   - `type='note'` → momento `kind='mark'` SIN `clip_id` (así la sala
 *     distingue nota de mark de clip) con su `title`.
 *
 * Errores de dominio (transmisión ajena, no live, sin ancla temporal) salen
 * como `AppError` con su status — la ruta los mapea tal cual.
 */
export async function createManualMark(
    input: ManualMarkInput,
    deps: ManualMarkDeps = {},
): Promise<ManualMarkResult> {
    const store = deps.store ?? createDrizzleLiveRoomStore();
    const now = deps.now?.() ?? new Date();

    const transmission = await store.findTransmission(
        input.tenantId,
        input.transmissionId,
    );
    if (!transmission) {
        throw new AppError('Transmisión no encontrada', 404);
    }
    if (transmission.status !== 'live') {
        throw new AppError(
            `La transmisión no está en vivo (estado '${transmission.status}'): el mark manual sólo aplica mientras hay señal`,
            409,
        );
    }
    if (!transmission.startedAt) {
        throw new AppError(
            'La transmisión en vivo no tiene started_at: no se puede anclar el mark al timeline',
            409,
        );
    }

    const nowMs = Math.max(0, now.getTime() - transmission.startedAt.getTime());

    if (input.type === 'note') {
        const moment = await store.insertMoment({
            tenantId: input.tenantId,
            transmissionId: input.transmissionId,
            kind: 'mark',
            startMs: nowMs,
            endMs: nowMs,
            title: input.title?.trim() || 'Nota del editor',
            reason: 'nota manual',
            score: null,
            clipId: null,
        });
        return { moment: serializeMoment(moment), clip: null };
    }

    const windowSeconds = input.windowSeconds ?? DEFAULT_MARK_WINDOW_SECONDS;
    const startMs = Math.max(0, nowMs - windowSeconds * 1000);
    const windowDurationSeconds = Math.max(
        1,
        Math.round((nowMs - startMs) / 1000),
    );

    const clip = await store.insertClip({
        tenantId: input.tenantId,
        transmissionId: input.transmissionId,
        programId: transmission.programId,
        title: `Clip manual ${windowSeconds}s`,
        hookText: 'Mark manual de la sala en vivo',
        duration: windowDurationSeconds,
        status: 'generating',
        metadata: {
            origin: 'manual_mark',
            startMs,
            endMs: nowMs,
            windowSeconds,
        },
    });

    const moment = await store.insertMoment({
        tenantId: input.tenantId,
        transmissionId: input.transmissionId,
        kind: 'mark',
        startMs,
        endMs: nowMs,
        title: 'Mark manual',
        reason: 'mark manual',
        score: null,
        clipId: clip.id,
    });

    return { moment: serializeMoment(moment), clip: serializeClip(clip) };
}
