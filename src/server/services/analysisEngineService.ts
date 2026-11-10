/**
 * analysisEngineService — motor de análisis en vivo (PE-02).
 *
 * Conecta la ingesta (Épica D) con el análisis (Épica E): dado un segmento
 * de grabación MP4 ya persistido por `streamRecorderService`, el motor
 *   extrae el audio → transcribe (diarizado) → escribe `transcript_segments`
 *   → analiza la ventana de texto con el modelo de 'analysis' → escribe
 *   `transmission_segments` (unidades temáticas) y `transmission_moments`
 *   (momentos clipables + citas) → dispara `liveAlertsService`.
 *
 * Contratos heredados — nada se reimplementa:
 *   - `transcribeAudio` (transcriptionService): utterances con start/end en
 *     ms RELATIVOS AL ARCHIVO — el motor les suma `segment.start_ms` para
 *     quedar en la convención wall-clock de `transmissions.started_at`.
 *   - `transmissionSegmentsService` (PE-06): escritura de segmentos
 *     temáticos — el motor no inserta en la tabla a mano.
 *   - `liveAlertsService.checkTranscriptAlerts` (PE-07): fire-and-forget por
 *     cada chunk de texto nuevo — un fallo de alertas nunca corta el loop.
 *   - `resolveAnalysisProvider('analysis')` (PE-01): selección del modelo de
 *     análisis — nunca hardcodeado (gemini por defecto, JSON mode).
 *   - `getRawStorage()` (PD-01): el `file_ref` del segmento es relativo al
 *     `storage_prefix` del stream_recording; la key completa es
 *     `${storagePrefix}/${fileRef}` y `publicPath` devuelve la ruta del MP4.
 *   - `findBinary('ffmpeg')`: extracción de audio `-vn -acodec libmp3lame`
 *     a un archivo temp que el caller borra después de transcribir.
 *
 * Patrón Store como el resto del repo: `AnalysisEngineStore` + impl drizzle
 * + factory con deps inyectables — los tests corren sin DB, sin ffmpeg y
 * sin APIs externas. TODA query del store filtra por `tenant_id`.
 *
 * `processRecordingSegment` es el camino por segmento (lo llama el
 * orquestador en vivo cuando un segmento cierra). `processTransmission` es
 * el camino post-hoc/testing: itera las `stream_recordings` de la
 * transmisión y procesa cada `recording_segments` 'active' en orden. Un
 * segmento que falla se loguea y se saltea — nunca corta el loop. Este
 * slice NO crea worker/scheduler ni eventos de socket: el servicio ES el
 * contrato.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { and, asc, eq } from 'drizzle-orm';

import type { DiarizedTranscription } from '../../shared/types.js';
import { db, type Database } from '../db/index.js';
import {
  transcriptSegments,
  transmissionMoments,
  type TransmissionSegmentSpeaker,
} from '../db/schema/live.js';
import { recordingSegments, streamRecordings } from '../db/schema/recordings.js';
import { transmissions } from '../db/schema/transmissions.js';
import { findBinary } from '../lib/binaries.js';
import {
  resolveAnalysisProvider,
  type ResolvedAnalysisProvider,
} from '../lib/analysisProviders.js';
import { getRawStorage, type RawStorage } from './rawStorageService.js';
import { transcribeAudio } from './transcriptionService.js';
import { liveAlertsService } from './liveAlertsService.js';
import {
  transmissionSegmentsService,
  type TransmissionSegmentInsert,
} from './transmissionSegmentsService.js';

// ─── Resultado del análisis (lo que devuelve el modelo) ─────────────────────

/** Unidad temática → `transmission_segments` (vía transmissionSegmentsService). */
export interface AnalysisResultSegment {
  startMs: number;
  endMs: number;
  topic?: string | null;
  summary?: string | null;
  speakers?: TransmissionSegmentSpeaker[];
  confidence?: number | null;
}

/** Momento clipable → `transmission_moments` kind='detected'. */
export interface AnalysisResultMoment {
  startMs: number;
  endMs: number;
  title?: string | null;
  reason?: string | null;
  score?: number | null;
}

/**
 * Cita textual → `transmission_moments` con `reason='quote'` y `title` =
 * texto de la cita (PE-05 las enriquece después — acá basta persistirlas).
 */
export interface AnalysisResultQuote {
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel?: string | null;
}

export interface AnalysisResult {
  segments: AnalysisResultSegment[];
  moments: AnalysisResultMoment[];
  quotes: AnalysisResultQuote[];
}

// ─── Store ──────────────────────────────────────────────────────────────────

export interface EngineTransmission {
  id: string;
  tenantId: string;
  status: string;
  programId: string | null;
}

export interface EngineRecording {
  id: string;
  tenantId: string;
  transmissionId: string;
  storagePrefix: string;
  status: string;
}

export interface EngineRecordingSegment {
  id: string;
  tenantId: string;
  recordingId: string;
  sequence: number;
  startMs: number;
  /** NULL mientras el segmento sigue escribiendo. */
  endMs: number | null;
  /** Relativo al `storage_prefix` del recording (nunca absoluto). */
  fileRef: string;
  status: string;
}

export interface TranscriptSegmentInsert {
  transmissionId: string;
  /** Offsets absolutos (ms relativos a `transmissions.started_at`). */
  startMs: number;
  endMs: number;
  speakerLabel?: string | null;
  text: string;
  confidence?: number | null;
}

export interface MomentInsert {
  transmissionId: string;
  /** Default 'detected' — los marks manuales los escribe la sala, no el motor. */
  kind?: string;
  startMs: number;
  endMs: number;
  title?: string | null;
  reason?: string | null;
  score?: number | null;
}

export interface AnalysisEngineStore {
  getTransmission(
    tenantId: string,
    transmissionId: string,
  ): Promise<EngineTransmission | null>;
  getRecording(
    tenantId: string,
    recordingId: string,
  ): Promise<EngineRecording | null>;
  /** Grabaciones de la transmisión en orden de creación. */
  listRecordings(
    tenantId: string,
    transmissionId: string,
  ): Promise<EngineRecording[]>;
  /** Segmentos físicos de una grabación ordenados por `sequence`. */
  listRecordingSegments(
    tenantId: string,
    recordingId: string,
  ): Promise<EngineRecordingSegment[]>;
  /** Batch de utterances ya mapeadas a offsets absolutos. */
  insertTranscriptSegments(
    tenantId: string,
    rows: TranscriptSegmentInsert[],
  ): Promise<void>;
  insertMoment(tenantId: string, v: MomentInsert): Promise<{ id: string }>;
}

/** Implementación drizzle — todas las queries filtran por tenant_id. */
export function createDrizzleAnalysisEngineStore(
  executor: Database = db,
): AnalysisEngineStore {
  return {
    async getTransmission(tenantId, transmissionId) {
      const [row] = await executor
        .select({
          id: transmissions.id,
          tenantId: transmissions.tenantId,
          status: transmissions.status,
          programId: transmissions.programId,
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

    async getRecording(tenantId, recordingId) {
      const [row] = await executor
        .select({
          id: streamRecordings.id,
          tenantId: streamRecordings.tenantId,
          transmissionId: streamRecordings.transmissionId,
          storagePrefix: streamRecordings.storagePrefix,
          status: streamRecordings.status,
        })
        .from(streamRecordings)
        .where(
          and(
            eq(streamRecordings.id, recordingId),
            eq(streamRecordings.tenantId, tenantId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async listRecordings(tenantId, transmissionId) {
      return executor
        .select({
          id: streamRecordings.id,
          tenantId: streamRecordings.tenantId,
          transmissionId: streamRecordings.transmissionId,
          storagePrefix: streamRecordings.storagePrefix,
          status: streamRecordings.status,
        })
        .from(streamRecordings)
        .where(
          and(
            eq(streamRecordings.transmissionId, transmissionId),
            eq(streamRecordings.tenantId, tenantId),
          ),
        )
        .orderBy(asc(streamRecordings.createdAt));
    },

    async listRecordingSegments(tenantId, recordingId) {
      return executor
        .select({
          id: recordingSegments.id,
          tenantId: recordingSegments.tenantId,
          recordingId: recordingSegments.recordingId,
          sequence: recordingSegments.sequence,
          startMs: recordingSegments.startMs,
          endMs: recordingSegments.endMs,
          fileRef: recordingSegments.fileRef,
          status: recordingSegments.status,
        })
        .from(recordingSegments)
        .where(
          and(
            eq(recordingSegments.recordingId, recordingId),
            eq(recordingSegments.tenantId, tenantId),
          ),
        )
        .orderBy(asc(recordingSegments.sequence));
    },

    async insertTranscriptSegments(tenantId, rows) {
      if (!rows.length) return;
      await executor.insert(transcriptSegments).values(
        rows.map((r) => ({
          tenantId,
          transmissionId: r.transmissionId,
          startMs: r.startMs,
          endMs: r.endMs,
          speakerLabel: r.speakerLabel ?? null,
          personId: null, // la atribución speaker→persona es de PE-03
          text: r.text,
          confidence: r.confidence ?? null,
        })),
      );
    },

    async insertMoment(tenantId, v) {
      const [row] = await executor
        .insert(transmissionMoments)
        .values({
          tenantId,
          transmissionId: v.transmissionId,
          kind: v.kind ?? 'detected',
          startMs: v.startMs,
          endMs: v.endMs,
          title: v.title ?? null,
          reason: v.reason ?? null,
          score: v.score ?? null,
          clipId: null, // el vínculo al clip lo hace el camino de clips
        })
        .returning({ id: transmissionMoments.id });
      return row;
    },
  };
}

// ─── Deps inyectables ───────────────────────────────────────────────────────

export interface AnalyzeInput {
  /**
   * Ventana de transcripción nueva, una línea por utterance con sus offsets
   * absolutos inline (`[startMs-endMs] Speaker: texto`) — el modelo devuelve
   * startMs/endMs en la misma convención.
   */
  transcript: string;
  /** Ventana(s) ya analizadas — contexto para no repetir temas/momentos. */
  prevContext?: string;
}

export type AnalyzeFn = (input: AnalyzeInput) => Promise<AnalysisResult>;
export type TranscribeFn = (filePath: string) => Promise<DiarizedTranscription>;
export type ExtractAudioFn = (fileRef: string) => Promise<string>;
export type AlertsFn = (
  tenantId: string,
  transmissionId: string,
  text: string,
) => unknown;

/** Escritor de `transmission_segments` — en prod el servicio real (PE-06). */
export interface TransmissionSegmentWriter {
  recordSegment(v: TransmissionSegmentInsert): Promise<unknown>;
}

export interface AnalysisEngineDeps {
  /** Default `transcribeAudio` (registry PE-01: AssemblyAI → Whisper). */
  transcribe?: TranscribeFn;
  /** Default `analyzeTranscriptWindow` (provider de 'analysis', JSON mode). */
  analyze?: AnalyzeFn;
  /** Default: ffmpeg real sobre `storage.publicPath(fileRef)`. */
  extractAudio?: ExtractAudioFn;
  /** Default `liveAlertsService.checkTranscriptAlerts` — fire-and-forget. */
  alerts?: AlertsFn;
  /** Default `transmissionSegmentsService` (PE-06). */
  segments?: TransmissionSegmentWriter;
  /** RawStorage del `extractAudio` por defecto. */
  storage?: RawStorage;
  ffmpegPath?: string;
  /** Dir para los audios temp extraídos. Default `os.tmpdir()`. */
  tmpDir?: string;
}

// ─── extractAudio real (ffmpeg) ─────────────────────────────────────────────

/**
 * `extractAudio` real: resuelve el MP4 desde la key de RawStorage y corre
 * `ffmpeg -vn -acodec libmp3lame` a un archivo temp. Devuelve el path — el
 * motor lo borra (best-effort) después de transcribir.
 */
export function createFfmpegExtractAudio(opts: {
  storage?: RawStorage;
  ffmpegPath?: string;
  tmpDir?: string;
} = {}): ExtractAudioFn {
  const storage = opts.storage ?? getRawStorage();
  const ffmpeg = opts.ffmpegPath ?? findBinary('ffmpeg');
  const tmpDir = opts.tmpDir ?? os.tmpdir();

  return (fileRef) =>
    new Promise<string>((resolve, reject) => {
      const input = storage.publicPath(fileRef);
      const output = path.join(tmpDir, `pe02-audio-${randomUUID()}.mp3`);
      const proc = spawn(ffmpeg, [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', input,
        '-vn',
        '-acodec', 'libmp3lame',
        '-q:a', '4',
        '-y',
        output,
      ]);

      let stderr = '';
      proc.stderr?.on('data', (d: Buffer | string) => {
        stderr += d.toString();
      });
      proc.on('error', (err: Error) => {
        reject(new Error(`No se pudo ejecutar ffmpeg: ${err.message}`));
      });
      proc.on('close', (code: number | null) => {
        if (code !== 0) {
          void fs.unlink(output).catch(() => {});
          reject(
            new Error(
              `ffmpeg extrayendo audio de ${fileRef} salió con código ${code ?? 'null'}: ${stderr.slice(-300)}`,
            ),
          );
          return;
        }
        resolve(output);
      });
    });
}

// ─── Analyzer real (provider de 'analysis', JSON mode) ──────────────────────

const ANALYSIS_WINDOW_PROMPT = (transcript: string, prevContext?: string) => `
Sos el motor de análisis editorial de una transmisión en vivo. Analizás la
transcripción diarizada de un segmento: cada línea tiene su ventana
[startMs-endMs] en milisegundos relativos al inicio de la transmisión, el
speaker y el texto.
${prevContext?.trim() ? `
Contexto ya analizado de la misma transmisión (no repitas temas, momentos ni
citas que ya están cubiertos ahí):
"""
${prevContext.trim()}
"""
` : ''}
Transcripción nueva a analizar:
"""
${transcript}
"""

Devolvé SOLO un JSON válido con esta forma exacta:
{
  "segments": [
    { "startMs": 0, "endMs": 0, "topic": "tema del bloque", "summary": "resumen corto",
      "speakers": [{ "label": "Speaker A" }], "confidence": 0.9 }
  ],
  "moments": [
    { "startMs": 0, "endMs": 0, "title": "qué pasó", "reason": "por qué es clipable", "score": 0.8 }
  ],
  "quotes": [
    { "startMs": 0, "endMs": 0, "text": "cita textual exacta", "speakerLabel": "Speaker A" }
  ]
}

Reglas:
- "segments" son las unidades temáticas de la ventana (puede ser una sola
  si todo el tramo es del mismo tema).
- "moments" son momentos clipables: declaraciones fuertes, datos duros,
  picos emocionales, remates. score 0–1 = qué tan clipable es. Sé selectivo.
- "quotes" son citas textuales EXACTAS de la transcripción.
- Todos los startMs/endMs usan la convención de las líneas (ms desde el
  inicio de la transmisión) y tienen que caer dentro de las ventanas
  transcritas.
- Si no hay nada relevante, devolvé arrays vacíos — nunca inventes contenido.
`.trim();

function extractJson(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  return (fenced ? fenced[1] : raw).trim();
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function normalizeSpeakers(v: unknown): TransmissionSegmentSpeaker[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((s): TransmissionSegmentSpeaker[] => {
    const label = strOrNull(typeof s === 'string' ? s : (s as { label?: unknown })?.label);
    if (!label) return [];
    const personId =
      typeof s === 'object' && s !== null
        ? strOrNull((s as { personId?: unknown }).personId)
        : null;
    return [{ label, personId }];
  });
}

/** Parsea y sanea el JSON del modelo — entradas inválidas se descartan. */
export function parseAnalysisResult(raw: string): AnalysisResult {
  const parsed = JSON.parse(extractJson(raw)) as Record<string, unknown>;
  const asArray = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((e): e is Record<string, unknown> => e != null && typeof e === 'object') : [];

  const segments = asArray(parsed?.segments).flatMap((s): AnalysisResultSegment[] => {
    const startMs = numOrNull(s.startMs);
    const endMs = numOrNull(s.endMs);
    if (startMs === null || endMs === null) return [];
    return [{
      startMs, endMs,
      topic: strOrNull(s.topic),
      summary: strOrNull(s.summary),
      speakers: normalizeSpeakers(s.speakers),
      confidence: numOrNull(s.confidence),
    }];
  });

  const moments = asArray(parsed?.moments).flatMap((m): AnalysisResultMoment[] => {
    const startMs = numOrNull(m.startMs);
    const endMs = numOrNull(m.endMs);
    if (startMs === null || endMs === null) return [];
    return [{
      startMs, endMs,
      title: strOrNull(m.title),
      reason: strOrNull(m.reason),
      score: numOrNull(m.score),
    }];
  });

  const quotes = asArray(parsed?.quotes).flatMap((q): AnalysisResultQuote[] => {
    const startMs = numOrNull(q.startMs);
    const endMs = numOrNull(q.endMs);
    const text = strOrNull(q.text);
    if (startMs === null || endMs === null || !text) return [];
    return [{ startMs, endMs, text, speakerLabel: strOrNull(q.speakerLabel) }];
  });

  return { segments, moments, quotes };
}

/**
 * Llamada real al modelo: el proveedor lo resuelve el registry PE-01
 * (`resolveAnalysisProvider('analysis')`) — nunca hardcodeado. El dispatch
 * es por `provider.id` resuelto: gemini → generateContent con
 * `responseMimeType: application/json`; openai-vision → chat/completions
 * con `response_format: json_object`. Otro id que el registry habilite a
 * futuro sin caller acá → error explícito, nunca fallback silencioso.
 */
async function callAnalysisProvider(
  provider: ResolvedAnalysisProvider,
  prompt: string,
): Promise<string> {
  const apiKey = provider.envKeys.map((k) => process.env[k]).find(Boolean);
  if (!apiKey) {
    throw new Error(
      `Falta la API key del proveedor '${provider.id}' (requiere ${provider.envKeys.join(' + ')})`,
    );
  }

  if (provider.id === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent?key=${apiKey}`;
    const res = await axios.post(
      url,
      {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2,
          maxOutputTokens: 4096,
        },
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 60_000 },
    );
    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error(`Gemini (${provider.model}) devolvió una respuesta vacía`);
    return String(text);
  }

  if (provider.id === 'openai-vision') {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: provider.model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 4096,
      },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 60_000 },
    );
    const text = res.data?.choices?.[0]?.message?.content;
    if (!text) throw new Error(`OpenAI (${provider.model}) devolvió una respuesta vacía`);
    return String(text);
  }

  throw new Error(
    `El proveedor '${provider.id}' resuelto para 'analysis' no tiene caller implementado en el motor`,
  );
}

/**
 * Analyzer real por defecto: prompt en español rioplatense (mismo estilo
 * que `alertService`) al modelo de 'analysis' en JSON mode, y parseo
 * defensivo del resultado. Los tests lo stubbean vía `deps.analyze` —
 * nunca corren el provider real.
 */
export async function analyzeTranscriptWindow(
  input: AnalyzeInput | string,
): Promise<AnalysisResult> {
  const { transcript, prevContext } =
    typeof input === 'string'
      ? { transcript: input, prevContext: undefined }
      : input;
  if (!transcript.trim()) return { segments: [], moments: [], quotes: [] };

  const provider = resolveAnalysisProvider('analysis');
  const raw = await callAnalysisProvider(
    provider,
    ANALYSIS_WINDOW_PROMPT(transcript, prevContext),
  );
  return parseAnalysisResult(raw);
}

// ─── Servicio ───────────────────────────────────────────────────────────────

export interface ProcessRecordingSegmentInput {
  tenantId: string;
  transmissionId: string;
  recordingId: string;
  sequence: number;
  /**
   * Ventana(s) ya analizadas de la misma transmisión — `processTransmission`
   * lo encadena solo; en llamadas sueltas queda undefined.
   */
  prevContext?: string;
}

export interface ProcessSegmentSummary {
  utterancesInserted: number;
  segmentsWritten: number;
  momentsWritten: number;
  quotesWritten: number;
  /**
   * Ventana que se pasó al analyzer (líneas con offsets absolutos) —
   * `processTransmission` la usa como `prevContext` del segmento siguiente.
   */
  transcript: string;
}

export interface ProcessTransmissionSummary {
  segmentsProcessed: number;
  segmentsFailed: number;
  utterancesInserted: number;
  segmentsWritten: number;
  momentsWritten: number;
  quotesWritten: number;
}

/** Tope de chars del contexto que se encadena entre segmentos. */
const MAX_PREV_CONTEXT_CHARS = 4_000;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Dispara alertas fire-and-forget: nunca devuelve promesa ni propaga
 * errores — ni rechazos async ni throws sync del dep (PE-07 es decorativo,
 * un fallo de detección no puede cortar el procesamiento del segmento).
 */
function fireTranscriptAlerts(
  alertsFn: AlertsFn,
  tenantId: string,
  transmissionId: string,
  text: string,
): void {
  try {
    Promise.resolve(alertsFn(tenantId, transmissionId, text)).catch((err) =>
      console.warn(`[AnalysisEngine] checkTranscriptAlerts falló: ${errMsg(err)}`),
    );
  } catch (err) {
    console.warn(`[AnalysisEngine] checkTranscriptAlerts falló: ${errMsg(err)}`);
  }
}

export function createAnalysisEngineService(
  store: AnalysisEngineStore = createDrizzleAnalysisEngineStore(),
  deps: AnalysisEngineDeps = {},
) {
  const transcribe = deps.transcribe ?? transcribeAudio;
  const analyze = deps.analyze ?? analyzeTranscriptWindow;
  const extractAudio =
    deps.extractAudio ??
    createFfmpegExtractAudio({
      storage: deps.storage,
      ffmpegPath: deps.ffmpegPath,
      tmpDir: deps.tmpDir,
    });
  const segmentsWriter: TransmissionSegmentWriter =
    deps.segments ?? transmissionSegmentsService;
  const alertsFn: AlertsFn =
    deps.alerts ??
    ((tenantId, transmissionId, text) =>
      liveAlertsService.checkTranscriptAlerts({ tenantId, transmissionId, text }));

  async function processRecordingSegment(
    input: ProcessRecordingSegmentInput,
  ): Promise<ProcessSegmentSummary> {
    const { tenantId, transmissionId, recordingId, sequence } = input;
    const summary: ProcessSegmentSummary = {
      utterancesInserted: 0,
      segmentsWritten: 0,
      momentsWritten: 0,
      quotesWritten: 0,
      transcript: '',
    };

    const tx = await store.getTransmission(tenantId, transmissionId);
    if (!tx) {
      throw new Error(
        `Transmisión ${transmissionId} no encontrada para el tenant ${tenantId}`,
      );
    }
    const recording = await store.getRecording(tenantId, recordingId);
    if (!recording) {
      throw new Error(
        `Grabación ${recordingId} no encontrada para el tenant ${tenantId}`,
      );
    }
    const segments = await store.listRecordingSegments(tenantId, recordingId);
    const segment = segments.find((s) => s.sequence === sequence);
    if (!segment) {
      throw new Error(
        `Segmento ${sequence} de la grabación ${recordingId} no encontrado`,
      );
    }

    // `file_ref` es siempre relativo al storage_prefix ('seg-00001.mp4' del
    // recorder, 'vod/seg-00001.mp4' del VOD): la key de RawStorage es
    // `${storagePrefix}/${fileRef}`.
    const fileRef = `${recording.storagePrefix}/${segment.fileRef}`;
    const audioPath = await extractAudio(fileRef);
    try {
      const diarized = await transcribe(audioPath);
      const utterances = diarized.utterances ?? [];
      const newText =
        diarized.diarizedText?.trim() ||
        diarized.text?.trim() ||
        utterances.map((u) => u.text).join(' ').trim();

      // Sin utterances no hay offsets relativos al archivo que mapear: no se
      // escribe transcript_segments ni se corre análisis (el modelo no
      // tendría anclas temporales). Si igual hay texto plano (p.ej. whisper),
      // es un chunk nuevo → alertas igual (no necesita offsets).
      if (!utterances.length) {
        console.warn(
          `[AnalysisEngine] segmento ${recordingId}#${sequence}: transcripción sin utterances, no se escribe nada`,
        );
        if (newText) {
          fireTranscriptAlerts(alertsFn, tenantId, transmissionId, newText);
        }
        return summary;
      }

      // Offsets ABSOLUTOS: utterance.start/end son ms relativos AL ARCHIVO —
      // se les suma segment.start_ms (convención transmissions.started_at).
      const rows: TranscriptSegmentInsert[] = utterances.map((u) => ({
        transmissionId,
        startMs: Math.max(0, Math.round(segment.startMs + u.start)),
        endMs: Math.max(0, Math.round(segment.startMs + u.end)),
        speakerLabel: u.speaker ?? null,
        text: u.text,
        confidence: null,
      }));
      await store.insertTranscriptSegments(tenantId, rows);
      summary.utterancesInserted = rows.length;

      // Ventana con offsets absolutos inline — el modelo devuelve
      // startMs/endMs en la misma convención.
      const transcript = utterances
        .map(
          (u) =>
            `[${Math.round(segment.startMs + u.start)}-${Math.round(segment.startMs + u.end)}ms] ${u.speaker}: ${u.text}`,
        )
        .join('\n');
      summary.transcript = transcript;

      // El análisis es best-effort: las utterances ya quedaron persistidas —
      // el segmento NO "falla" por el modelo caído.
      let analysis: AnalysisResult | null = null;
      try {
        analysis = await analyze({
          transcript,
          prevContext: input.prevContext,
        });
      } catch (err) {
        console.warn(
          `[AnalysisEngine] analyze falló en ${recordingId}#${sequence}: ${errMsg(err)}`,
        );
      }

      if (analysis) {
        for (const seg of analysis.segments ?? []) {
          await segmentsWriter.recordSegment({
            tenantId,
            transmissionId,
            startMs: seg.startMs,
            endMs: seg.endMs,
            topic: seg.topic ?? null,
            summary: seg.summary ?? null,
            speakers: seg.speakers ?? [],
            confidence: seg.confidence ?? null,
          });
          summary.segmentsWritten++;
        }
        for (const m of analysis.moments ?? []) {
          await store.insertMoment(tenantId, {
            transmissionId,
            kind: 'detected',
            startMs: m.startMs,
            endMs: m.endMs,
            title: m.title ?? null,
            reason: m.reason ?? null,
            score: m.score ?? null,
          });
          summary.momentsWritten++;
        }
        // Las citas van a transmission_moments con reason='quote' y
        // title = texto de la cita (PE-05 las enriquece después).
        for (const q of analysis.quotes ?? []) {
          await store.insertMoment(tenantId, {
            transmissionId,
            kind: 'detected',
            startMs: q.startMs,
            endMs: q.endMs,
            title: q.text,
            reason: 'quote',
            score: null,
          });
          summary.quotesWritten++;
        }
      }

      // Alertas sobre el texto nuevo — fire-and-forget (PE-07): un fallo de
      // detección no puede cortar el procesamiento del segmento.
      if (newText) {
        fireTranscriptAlerts(alertsFn, tenantId, transmissionId, newText);
      }

      return summary;
    } finally {
      // El audio extraído es un intermedio — best-effort, nunca tapa el
      // resultado del segmento.
      void fs.unlink(audioPath).catch(() => {});
    }
  }

  async function processTransmission(input: {
    tenantId: string;
    transmissionId: string;
  }): Promise<ProcessTransmissionSummary> {
    const { tenantId, transmissionId } = input;
    const tx = await store.getTransmission(tenantId, transmissionId);
    if (!tx) {
      throw new Error(
        `Transmisión ${transmissionId} no encontrada para el tenant ${tenantId}`,
      );
    }

    const recordings = await store.listRecordings(tenantId, transmissionId);
    const totals: ProcessTransmissionSummary = {
      segmentsProcessed: 0,
      segmentsFailed: 0,
      utterancesInserted: 0,
      segmentsWritten: 0,
      momentsWritten: 0,
      quotesWritten: 0,
    };

    let prevContext: string | undefined;
    for (const recording of recordings) {
      // Sólo 'active': los 'purged' ya no tienen archivo en storage.
      const segments = (await store.listRecordingSegments(tenantId, recording.id))
        .filter((s) => s.status === 'active')
        .sort((a, b) => a.sequence - b.sequence);

      for (const segment of segments) {
        try {
          const res = await processRecordingSegment({
            tenantId,
            transmissionId,
            recordingId: recording.id,
            sequence: segment.sequence,
            prevContext,
          });
          totals.segmentsProcessed++;
          totals.utterancesInserted += res.utterancesInserted;
          totals.segmentsWritten += res.segmentsWritten;
          totals.momentsWritten += res.momentsWritten;
          totals.quotesWritten += res.quotesWritten;
          if (res.transcript) {
            prevContext = res.transcript.slice(-MAX_PREV_CONTEXT_CHARS);
          }
        } catch (err) {
          // Un segmento que falla se loguea y se saltea — nunca corta el loop.
          totals.segmentsFailed++;
          console.error(
            `[AnalysisEngine] segmento ${recording.id}#${segment.sequence} falló: ${errMsg(err)}`,
          );
        }
      }
    }
    return totals;
  }

  return { processRecordingSegment, processTransmission };
}

export const analysisEngineService = createAnalysisEngineService();
