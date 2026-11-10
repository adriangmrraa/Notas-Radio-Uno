/**
 * personIdentityService — atribución de identidad a los speakers de la
 * diarización (PE-03): `speaker_label` → `person_id`.
 *
 * Por cada speaker sin resolver de `transcript_segments` (person_id IS NULL):
 *   samplea N frames del video dentro de SU ventana temporal → detecta
 *   rostros (SCRFD+ArcFace vía `getFaceDetector`, 512d) → matchea cada
 *   embedding contra `face_embeddings` por distancia coseno pgvector (`<=>`,
 *   HNSW vector_cosine_ops) → vota la persona con más coincidencias bajo
 *   umbral → escribe la asignación.
 *
 * Contratos heredados — nada se reimplementa:
 *   - `getFaceDetector()` (faceDetectionService, PC-04): detector inyectable;
 *     `FakeFaceDetector` en tests. Embeddings ArcFace normalizados de 512 dims.
 *   - `face_embeddings` (persons.ts): `vector(512)` con distancia coseno
 *     `<=>`. Umbral por defecto `FACE_MATCH_THRESHOLD = 0.35` (constante
 *     configurable vía deps).
 *   - `recording_segments` + `stream_recordings` (recordings.ts): los frames
 *     salen del MP4 `${storagePrefix}/${fileRef}` vía `getRawStorage()` —
 *     misma convención que PE-02. El `start_ms`/`end_ms` de cada segmento es
 *     wall-clock relativo a `transmissions.started_at`; el `-ss` de ffmpeg se
 *     alimenta del offset RELATIVO AL ARCHIVO (t − segment.startMs).
 *   - `transmissionSegmentsService` (PE-06): tras asignar/corregir se propaga
 *     el personId al jsonb `speakers` de los segmentos temáticos — sólo a
 *     labels que coincidan y, en el camino automático, sólo donde personId
 *     todavía sea NULL (la corrección manual persiste igual que en
 *     transcript_segments).
 *   - `findBinary('ffmpeg')`: extracción de frame
 *     `-ss <t> -i <mp4> -frames:v 1 -f image2pipe -vcodec mjpeg -` → Buffer.
 *
 * AC central: LA CORRECCIÓN MANUAL PERSISTE — `assignPersonToSpeaker` escribe
 * sólo donde `person_id IS NULL`; el override explícito es
 * `overrideSpeakerPerson`/`correctSpeakerPerson` (admite null = desasignar).
 *
 * Un frame sin rostro, un rostro sin match bajo umbral o un speaker sin
 * frames → `personId=null` con `reason` registrada en la resolución; un
 * speaker que falla NUNCA rompe el loop de los demás. TODA query del store
 * filtra por `tenant_id`.
 */
import { spawn } from 'node:child_process';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import {
  transcriptSegments,
  type TransmissionSegmentSpeaker,
} from '../db/schema/live.js';
import { recordingSegments, streamRecordings } from '../db/schema/recordings.js';
import { faceEmbeddings, persons } from '../db/schema/persons.js';
import { transmissions } from '../db/schema/transmissions.js';
import { findBinary } from '../lib/binaries.js';
import { getRawStorage, type RawStorage } from './rawStorageService.js';
import {
  getFaceDetector,
  type DetectedFace,
} from './faceDetectionService.js';
import { transmissionSegmentsService } from './transmissionSegmentsService.js';

// ─── Constantes ─────────────────────────────────────────────────────────────

/**
 * Umbral de distancia coseno ArcFace (embeddings L2-normalizados): un match
 * con distancia <= 0.35 vota por la persona; por encima no cuenta.
 */
export const FACE_MATCH_THRESHOLD = 0.35;
/** Frames sampleados por speaker dentro de su ventana temporal. */
export const DEFAULT_SAMPLES_PER_SPEAKER = 5;
/** Candidatos que pide `matchEmbedding` por embedding detectado (top-k). */
export const MATCH_CANDIDATES = 3;

// ─── Tipos del store ────────────────────────────────────────────────────────

export interface IdentityTransmission {
  id: string;
  tenantId: string;
  status: string;
}

/**
 * Speaker de la diarización con utterances sin atribuir: `startMs`/`endMs`
 * son el rango temporal a samplear — min(start_ms) → max(end_ms) de sus
 * segmentos con `person_id IS NULL`.
 */
export interface UnresolvedSpeaker {
  speakerLabel: string;
  startMs: number;
  endMs: number;
  segmentCount: number;
}

/** Segmento físico de grabación con su prefijo de storage ya resuelto. */
export interface IdentityRecordingSegment {
  recordingId: string;
  sequence: number;
  /** Offsets wall-clock relativos a `transmissions.started_at`. */
  startMs: number;
  endMs: number | null;
  /** Relativo al `storagePrefix` del recording (nunca absoluto). */
  fileRef: string;
  storagePrefix: string;
  status: string;
}

/** Candidato de `face_embeddings` ordenado por distancia coseno ASC. */
export interface EmbeddingMatch {
  personId: string;
  personName: string;
  /** Distancia coseno pgvector (`<=>`): 0 = idéntico, 2 = opuesto. */
  distance: number;
}

export interface PersonIdentityStore {
  getTransmission(
    tenantId: string,
    transmissionId: string,
  ): Promise<IdentityTransmission | null>;
  /**
   * Speaker labels distintos con `person_id IS NULL` en la transmisión,
   * con su rango temporal (min start_ms → max end_ms) y cantidad de
   * segmentos. Ordenados por primer aparición.
   */
  listUnresolvedSpeakers(
    tenantId: string,
    transmissionId: string,
  ): Promise<UnresolvedSpeaker[]>;
  /**
   * Segmentos físicos de TODAS las grabaciones de la transmisión (join
   * `stream_recordings` para `storage_prefix` + filtro por transmission_id),
   * ordenados por `start_ms`/`sequence` — el servicio elige el que cubre
   * cada ms sampleado.
   */
  listRecordingSegments(
    tenantId: string,
    transmissionId: string,
  ): Promise<IdentityRecordingSegment[]>;
  /** Top-`limit` de `face_embeddings` por distancia coseno `<=>` ASC. */
  matchEmbedding(
    tenantId: string,
    embedding: number[],
    limit: number,
  ): Promise<EmbeddingMatch[]>;
  /**
   * UPDATE `transcript_segments` SET person_id … `WHERE person_id IS NULL`
   * (AC: la resolución automática NUNCA pisa una atribución ya hecha — la
   * corrección manual persiste). Devuelve cuántas filas escribió.
   */
  assignPersonToSpeaker(
    tenantId: string,
    transmissionId: string,
    speakerLabel: string,
    personId: string,
  ): Promise<{ updated: number }>;
  /**
   * UPDATE forzado (corrección manual): pisa lo que haya, incluido null
   * para desasignar. Devuelve cuántas filas escribió.
   */
  overrideSpeakerPerson(
    tenantId: string,
    transmissionId: string,
    speakerLabel: string,
    personId: string | null,
  ): Promise<{ updated: number }>;
}

// ─── Implementación drizzle — todas las queries filtran por tenant_id ───────

export function createDrizzlePersonIdentityStore(
  executor: Database = db,
): PersonIdentityStore {
  return {
    async getTransmission(tenantId, transmissionId) {
      const [row] = await executor
        .select({
          id: transmissions.id,
          tenantId: transmissions.tenantId,
          status: transmissions.status,
        })
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

    async listUnresolvedSpeakers(tenantId, transmissionId) {
      const rows = await executor
        .select({
          speakerLabel: transcriptSegments.speakerLabel,
          startMs: sql<number>`min(${transcriptSegments.startMs})::int`,
          endMs: sql<number>`max(${transcriptSegments.endMs})::int`,
          segmentCount: sql<number>`count(*)::int`,
        })
        .from(transcriptSegments)
        .where(
          and(
            eq(transcriptSegments.tenantId, tenantId),
            eq(transcriptSegments.transmissionId, transmissionId),
            isNull(transcriptSegments.personId),
            isNotNull(transcriptSegments.speakerLabel),
          ),
        )
        .groupBy(transcriptSegments.speakerLabel)
        .orderBy(asc(sql`min(${transcriptSegments.startMs})`));
      // isNotNull ya filtró los labels vacíos — el casteo es seguro.
      return rows.map((r) => ({ ...r, speakerLabel: r.speakerLabel! }));
    },

    async listRecordingSegments(tenantId, transmissionId) {
      return executor
        .select({
          recordingId: recordingSegments.recordingId,
          sequence: recordingSegments.sequence,
          startMs: recordingSegments.startMs,
          endMs: recordingSegments.endMs,
          fileRef: recordingSegments.fileRef,
          storagePrefix: streamRecordings.storagePrefix,
          status: recordingSegments.status,
        })
        .from(recordingSegments)
        .innerJoin(
          streamRecordings,
          and(
            eq(streamRecordings.id, recordingSegments.recordingId),
            eq(streamRecordings.tenantId, tenantId),
          ),
        )
        .where(
          and(
            eq(recordingSegments.tenantId, tenantId),
            eq(streamRecordings.transmissionId, transmissionId),
          ),
        )
        .orderBy(asc(recordingSegments.startMs), asc(recordingSegments.sequence));
    },

    async matchEmbedding(tenantId, embedding, limit) {
      // Distancia coseno parametrizada: el array viaja como literal '[…]'
      // bindeado (no interpolado a mano) y se castea a ::vector — mismo
      // formato que drizzle aplica al insertar `number[]` en faceEnrollment.
      const distance = sql<number>`${faceEmbeddings.embedding} <=> ${JSON.stringify(embedding)}::vector`;
      return executor
        .select({
          personId: faceEmbeddings.personId,
          personName: persons.name,
          distance,
        })
        .from(faceEmbeddings)
        .innerJoin(
          persons,
          and(
            eq(persons.id, faceEmbeddings.personId),
            eq(persons.tenantId, tenantId),
          ),
        )
        .where(eq(faceEmbeddings.tenantId, tenantId))
        .orderBy(asc(distance))
        .limit(limit);
    },

    async assignPersonToSpeaker(tenantId, transmissionId, speakerLabel, personId) {
      const rows = await executor
        .update(transcriptSegments)
        .set({ personId })
        .where(
          and(
            eq(transcriptSegments.tenantId, tenantId),
            eq(transcriptSegments.transmissionId, transmissionId),
            eq(transcriptSegments.speakerLabel, speakerLabel),
            // AC: sólo donde aún no hay atribución — la corrección manual persiste.
            isNull(transcriptSegments.personId),
          ),
        )
        .returning({ id: transcriptSegments.id });
      return { updated: rows.length };
    },

    async overrideSpeakerPerson(tenantId, transmissionId, speakerLabel, personId) {
      const rows = await executor
        .update(transcriptSegments)
        .set({ personId })
        .where(
          and(
            eq(transcriptSegments.tenantId, tenantId),
            eq(transcriptSegments.transmissionId, transmissionId),
            eq(transcriptSegments.speakerLabel, speakerLabel),
          ),
        )
        .returning({ id: transcriptSegments.id });
      return { updated: rows.length };
    },
  };
}

// ─── Deps inyectables ───────────────────────────────────────────────────────

/** Detecta rostros en un frame JPEG: devuelve las caras con su embedding 512d. */
export type DetectFacesFn = (frame: Buffer) => Promise<DetectedFace[]>;
/**
 * Extrae UN frame del MP4 identificado por `fileRef` (key completa de
 * RawStorage: `${storagePrefix}/${fileRef}`) en el instante `atMs` RELATIVO
 * AL ARCHIVO. Devuelve la imagen (JPEG) como Buffer.
 */
export type ExtractFrameFn = (fileRef: string, atMs: number) => Promise<Buffer>;

/** Lectura/escritura del jsonb `speakers` de `transmission_segments` (PE-06). */
export interface SegmentSpeakersGateway {
  listSegments(
    tenantId: string,
    transmissionId: string,
  ): Promise<Array<{ id: string; speakers: TransmissionSegmentSpeaker[] }>>;
  setSegmentSpeakers(
    tenantId: string,
    segmentId: string,
    speakers: TransmissionSegmentSpeaker[],
  ): Promise<unknown>;
}

export interface PersonIdentityDeps {
  /** Default: `getFaceDetector()` (SCRFD+ArcFace real). Tests: FakeFaceDetector. */
  detectFaces?: DetectFacesFn;
  /** Default: ffmpeg real sobre `storage.publicPath(fileRef)`. */
  extractFrame?: ExtractFrameFn;
  /** Umbral de distancia coseno para que un match vote. Default 0.35. */
  matchThreshold?: number;
  /** Frames sampleados por ventana de speaker. Default 5. */
  samplesPerSpeaker?: number;
  /** Top-k pedido a `matchEmbedding` por rostro. Default 3. */
  matchCandidates?: number;
  /** Default `transmissionSegmentsService` (PE-06). */
  segments?: SegmentSpeakersGateway;
  /** RawStorage del `extractFrame` por defecto. */
  storage?: RawStorage;
  ffmpegPath?: string;
}

// ─── extractFrame real (ffmpeg → image2pipe mjpeg) ─────────────────────────

/**
 * `extractFrame` real: `ffmpeg -ss <t>s -i <mp4> -frames:v 1 -f image2pipe
 * -vcodec mjpeg -` y devuelve stdout como Buffer. `atMs` es relativo AL
 * ARCHIVO (ya viene descontado el startMs del segmento).
 */
export function createFfmpegExtractFrame(
  opts: { storage?: RawStorage; ffmpegPath?: string } = {},
): ExtractFrameFn {
  const storage = opts.storage ?? getRawStorage();
  const ffmpeg = opts.ffmpegPath ?? findBinary('ffmpeg');

  return (fileRef, atMs) =>
    new Promise<Buffer>((resolve, reject) => {
      const input = storage.publicPath(fileRef);
      const seconds = (Math.max(0, atMs) / 1000).toFixed(3);
      const proc = spawn(ffmpeg, [
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', seconds,
        '-i', input,
        '-frames:v', '1',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-',
      ]);

      const chunks: Buffer[] = [];
      let stderr = '';
      proc.stdout?.on('data', (d: Buffer | string) => {
        chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
      });
      proc.stderr?.on('data', (d: Buffer | string) => {
        stderr += d.toString();
      });
      proc.on('error', (err: Error) => {
        reject(new Error(`No se pudo ejecutar ffmpeg: ${err.message}`));
      });
      proc.on('close', (code: number | null) => {
        if (code !== 0) {
          reject(
            new Error(
              `ffmpeg extrayendo frame de ${fileRef}@${Math.round(atMs)}ms salió con código ${code ?? 'null'}: ${stderr.slice(-300)}`,
            ),
          );
          return;
        }
        if (!chunks.length) {
          reject(new Error(`ffmpeg no produjo frame para ${fileRef}@${Math.round(atMs)}ms`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
}

// ─── Servicio ───────────────────────────────────────────────────────────────

export type UnresolvedReason = 'no_frames' | 'no_faces' | 'below_threshold';

export interface SpeakerEvidence {
  /** Instantes de muestreo planificados dentro de la ventana del speaker. */
  samplesPlanned: number;
  /** Frames que `extractFrame` devolvió con éxito. */
  framesExtracted: number;
  /** Rostros detectados en total (todas las caras de todos los frames). */
  facesDetected: number;
  /** Rostros cuyo mejor match quedó bajo umbral (votos emitidos). */
  matchedFaces: number;
  /** Votos por personId (caras que matchearon bajo umbral). */
  votes: Record<string, number>;
  /** Menor distancia coseno vista entre los matches válidos. */
  bestDistance: number | null;
  /** Filas de `transcript_segments` que quedaron escritas con el personId. */
  segmentsAssigned: number;
}

export interface SpeakerResolution {
  speakerLabel: string;
  /** NULL cuando quedó sin resolver — ver `reason`. */
  personId: string | null;
  personName: string | null;
  /**
   * Confianza 0–1 cuando hay atribución: share de votos del ganador
   * ponderado por (1 − bestDistance). NULL sin atribución.
   */
  confidence: number | null;
  reason: UnresolvedReason | null;
  evidence: SpeakerEvidence;
}

export interface ResolveTransmissionSpeakersInput {
  tenantId: string;
  transmissionId: string;
}

export interface CorrectSpeakerPersonInput {
  tenantId: string;
  transmissionId: string;
  speakerLabel: string;
  /** NULL desasigna al speaker (pisa cualquier atribución previa). */
  personId: string | null;
}

export interface CorrectSpeakerPersonResult {
  speakerLabel: string;
  personId: string | null;
  /** Filas de `transcript_segments` actualizadas por el override. */
  segmentsUpdated: number;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Instantes de muestreo dentro de [startMs, endMs]: `n` puntos
 * equiespaciados (i/(n+1)) evitando los bordes exactos. Ventana
 * degenerada (startMs == endMs) → un único sample en startMs.
 */
export function sampleWindowTimes(startMs: number, endMs: number, n: number): number[] {
  const span = Math.max(0, endMs - startMs);
  const times = new Set<number>();
  for (let i = 1; i <= Math.max(1, n); i++) {
    times.add(Math.round(startMs + (span * i) / (n + 1)));
  }
  return [...times];
}

export function createPersonIdentityService(
  store: PersonIdentityStore = createDrizzlePersonIdentityStore(),
  deps: PersonIdentityDeps = {},
) {
  const detectFaces: DetectFacesFn =
    deps.detectFaces ??
    (async (frame) => (await (await getFaceDetector()).detect(frame)).faces);
  const extractFrame: ExtractFrameFn =
    deps.extractFrame ??
    createFfmpegExtractFrame({
      storage: deps.storage,
      ffmpegPath: deps.ffmpegPath,
    });
  const segmentsWriter: SegmentSpeakersGateway =
    deps.segments ?? transmissionSegmentsService;
  const matchThreshold = deps.matchThreshold ?? FACE_MATCH_THRESHOLD;
  const samplesPerSpeaker = deps.samplesPerSpeaker ?? DEFAULT_SAMPLES_PER_SPEAKER;
  const matchCandidates = deps.matchCandidates ?? MATCH_CANDIDATES;

  /**
   * Propaga la resolución al jsonb `speakers` de los segmentos temáticos
   * (PE-06), sólo a labels que coincidan. `onlyNull: true` (camino
   * automático) nunca pisa un personId ya presente — misma regla que el
   * WHERE person_id IS NULL de transcript_segments. Best-effort: un fallo
   * se loguea y no rompe la resolución.
   */
  async function propagateToSegments(
    tenantId: string,
    transmissionId: string,
    speakerLabel: string,
    personId: string | null,
    opts: { onlyNull: boolean },
  ): Promise<void> {
    try {
      const segments = await segmentsWriter.listSegments(tenantId, transmissionId);
      for (const segment of segments) {
        const speakers = segment.speakers ?? [];
        let changed = false;
        const next = speakers.map((s) => {
          if (s.label !== speakerLabel) return s;
          if (opts.onlyNull && s.personId != null) return s;
          if ((s.personId ?? null) === personId) return s;
          changed = true;
          return { ...s, personId };
        });
        if (changed) {
          await segmentsWriter.setSegmentSpeakers(tenantId, segment.id, next);
        }
      }
    } catch (err) {
      console.warn(
        `[PersonIdentity] propagación a transmission_segments falló: ${errMsg(err)}`,
      );
    }
  }

  /**
   * Resuelve UN speaker: samplea su ventana, detecta rostros, matchea
   * embeddings y vota. Nunca lanza por un frame/rostro individual —
   * devuelve la resolución con `reason` cuando no alcanzó la evidencia.
   */
  async function resolveSpeaker(
    tenantId: string,
    transmissionId: string,
    speaker: UnresolvedSpeaker,
    recSegments: IdentityRecordingSegment[],
  ): Promise<SpeakerResolution> {
    const evidence: SpeakerEvidence = {
      samplesPlanned: 0,
      framesExtracted: 0,
      facesDetected: 0,
      matchedFaces: 0,
      votes: {},
      bestDistance: null,
      segmentsAssigned: 0,
    };

    const active = recSegments.filter((s) => s.status === 'active');
    const times = sampleWindowTimes(speaker.startMs, speaker.endMs, samplesPerSpeaker);
    evidence.samplesPlanned = times.length;

    const votes = new Map<string, { votes: number; bestDistance: number; name: string }>();

    for (const t of times) {
      // Segmento que CUBRE t en wall-clock; el seek de ffmpeg es relativo
      // al archivo → t − segment.startMs.
      const seg = active.find(
        (s) => s.startMs <= t && (s.endMs === null || t < s.endMs),
      );
      if (!seg) continue;

      let frame: Buffer;
      try {
        frame = await extractFrame(
          `${seg.storagePrefix}/${seg.fileRef}`,
          Math.max(0, Math.round(t - seg.startMs)),
        );
      } catch {
        continue; // frame que no se pudo extraer — se saltea, no rompe.
      }
      evidence.framesExtracted++;

      let faces: DetectedFace[];
      try {
        faces = await detectFaces(frame);
      } catch {
        continue; // detector caído en este frame — idem.
      }
      evidence.facesDetected += faces.length;

      for (const face of faces) {
        if (!Array.isArray(face.embedding) || face.embedding.length === 0) continue;
        const matches = await store.matchEmbedding(tenantId, face.embedding, matchCandidates);
        const best = matches[0];
        if (!best || best.distance > matchThreshold) continue;
        evidence.matchedFaces++;
        evidence.votes[best.personId] = (evidence.votes[best.personId] ?? 0) + 1;
        evidence.bestDistance =
          evidence.bestDistance === null
            ? best.distance
            : Math.min(evidence.bestDistance, best.distance);
        const entry =
          votes.get(best.personId) ??
          { votes: 0, bestDistance: best.distance, name: best.personName };
        entry.votes++;
        entry.bestDistance = Math.min(entry.bestDistance, best.distance);
        votes.set(best.personId, entry);
      }
    }

    // Ganador por mayoría de votos; empate → menor mejor distancia.
    let winner: { personId: string; personName: string; votes: number; bestDistance: number } | null =
      null;
    for (const [personId, v] of votes) {
      if (
        !winner ||
        v.votes > winner.votes ||
        (v.votes === winner.votes && v.bestDistance < winner.bestDistance)
      ) {
        winner = {
          personId,
          personName: v.name,
          votes: v.votes,
          bestDistance: v.bestDistance,
        };
      }
    }

    if (!winner) {
      const reason: UnresolvedReason =
        evidence.framesExtracted === 0
          ? 'no_frames'
          : evidence.facesDetected === 0
            ? 'no_faces'
            : 'below_threshold';
      return {
        speakerLabel: speaker.speakerLabel,
        personId: null,
        personName: null,
        confidence: null,
        reason,
        evidence,
      };
    }

    const confidence =
      Math.round(((winner.votes / Math.max(1, evidence.matchedFaces)) *
        (1 - winner.bestDistance)) * 1000) / 1000;

    // WHERE person_id IS NULL adentro del store — la corrección manual persiste.
    const { updated } = await store.assignPersonToSpeaker(
      tenantId,
      transmissionId,
      speaker.speakerLabel,
      winner.personId,
    );
    evidence.segmentsAssigned = updated;

    await propagateToSegments(tenantId, transmissionId, speaker.speakerLabel, winner.personId, {
      onlyNull: true,
    });

    return {
      speakerLabel: speaker.speakerLabel,
      personId: winner.personId,
      personName: winner.personName,
      confidence,
      reason: null,
      evidence,
    };
  }

  /**
   * Resuelve todos los speakers sin atribuir de una transmisión. Devuelve
   * las resoluciones (una por speaker_label); un speaker que no llega a
   * evidencia suficiente queda `personId=null` + `reason` — nunca rompe
   * el loop de los demás.
   */
  async function resolveTransmissionSpeakers(
    input: ResolveTransmissionSpeakersInput,
  ): Promise<SpeakerResolution[]> {
    const { tenantId, transmissionId } = input;
    const tx = await store.getTransmission(tenantId, transmissionId);
    if (!tx) {
      throw new Error(
        `Transmisión ${transmissionId} no encontrada para el tenant ${tenantId}`,
      );
    }

    const unresolved = await store.listUnresolvedSpeakers(tenantId, transmissionId);
    if (!unresolved.length) return [];

    const recSegments = await store.listRecordingSegments(tenantId, transmissionId);

    const resolutions: SpeakerResolution[] = [];
    for (const speaker of unresolved) {
      try {
        resolutions.push(
          await resolveSpeaker(tenantId, transmissionId, speaker, recSegments),
        );
      } catch (err) {
        // Un speaker que falla inesperadamente se loguea y se saltea —
        // nunca corta la resolución de los demás.
        console.error(
          `[PersonIdentity] speaker '${speaker.speakerLabel}' falló: ${errMsg(err)}`,
        );
      }
    }
    return resolutions;
  }

  /**
   * Corrección manual de la atribución de un speaker: pisa lo que haya en
   * `transcript_segments` (incluido null para desasignar) y propaga el
   * override al jsonb `speakers` de los segmentos temáticos.
   */
  async function correctSpeakerPerson(
    input: CorrectSpeakerPersonInput,
  ): Promise<CorrectSpeakerPersonResult> {
    const { tenantId, transmissionId, speakerLabel, personId } = input;
    const { updated } = await store.overrideSpeakerPerson(
      tenantId,
      transmissionId,
      speakerLabel,
      personId,
    );
    await propagateToSegments(tenantId, transmissionId, speakerLabel, personId, {
      onlyNull: false,
    });
    return { speakerLabel, personId, segmentsUpdated: updated };
  }

  return { resolveTransmissionSpeakers, correctSpeakerPerson };
}

export const personIdentityService = createPersonIdentityService();
