import { Router, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import multer from "multer";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { requireAuth, requireActiveSubscription } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { scheduledTransmissions, transmissions } from "../db/schema/transmissions.js";
import { programs } from "../db/schema/programs.js";
import { TransmissionStatus } from "../db/schema/enums.js";
import { nextOccurrence } from "../lib/rrule.js";
import {
    buildSchedule,
    deriveSchedule,
    describeSchedule,
    occurrencesBetween,
    parseScheduleBody,
    valuesFromFields,
    MAX_DURATION_MINUTES,
    MIN_DURATION_MINUTES,
} from "../lib/scheduleRules.js";
import { AppError } from "../lib/errors.js";
import { STREAM_SOURCES } from "../lib/streamSources.js";
import {
    downloadVodToTemp,
    ingestVodUpload,
    VOD_VIDEO_EXTENSIONS,
    type VodIngestDeps,
} from "../services/vodUploadService.js";
import {
    startLiveTransmission,
    type StartLiveDeps,
} from "../services/startLiveService.js";
import { serializeTransmission } from "../services/transmissionService.js";

// ---------------------------------------------------------------------------
// Router — mounted at /api/transmissions (PC-08)
//
// Aislamiento: TODA query filtra por `req.auth!.tenantId` — el tenant nunca
// viene del body. Un id ajeno al tenant ⇒ 404 (no se distingue "no existe" de
// "es de otro").
//
// Gates de suscripción (mismo criterio que routes/jobs.ts y pipeline.ts):
// crear recursos (POST /scheduled) y disparar corridas (POST …/start, igual
// que POST /pipeline/start) exigen suscripción activa. Lectura/edición/borrado
// quedan sólo detrás de requireAuth.
// ---------------------------------------------------------------------------
export const transmissionsRouter = Router();

type ScheduledRow = typeof scheduledTransmissions.$inferSelect;

const VALID_RUN_STATUSES: readonly string[] = Object.values(TransmissionStatus);
const MS_PER_DAY = 86_400_000;
const DEFAULT_RUNS_LIMIT = 50;
const MAX_RUNS_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------
// PD-07 — multer para el upload VOD.
//
// El multer global de index.ts (`multer({ dest })`) no define límite de
// tamaño y el de persons.ts (5MB, memoryStorage) es para fotos — ninguno
// aplica a video. Acá va un límite propio y constante: 4 GiB, que cubre
// el rango de durationMinutes (hasta 480 min) a bitrates típicos de
// programa grabado. Disco (tmpdir del SO) y no memoria: un video no se
// bufferea entero en RAM antes de copiarse a RawStorage.
// ------------------------------------------------------------------
const VOD_UPLOAD_MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB
const VOD_TMP_DIR = path.join(os.tmpdir(), "periodistapp-vod");
const vodUploadMulter = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => {
            fs.mkdirSync(VOD_TMP_DIR, { recursive: true });
            cb(null, VOD_TMP_DIR);
        },
        filename: (_req, file, cb) => {
            cb(null, `vod-${randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
        },
    }),
    limits: { fileSize: VOD_UPLOAD_MAX_BYTES },
});

/** Multer single('file') con el error ya mapeado a 400 legible (patrón persons.ts). */
function vodUploadSingle(req: Request, res: Response, next: () => void): void {
    vodUploadMulter.single("file")(req, res, (err: unknown) => {
        if (err) {
            const message =
                err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
                    ? "El archivo supera el máximo de 4 GB"
                    : err instanceof Error
                        ? err.message
                        : "Archivo inválido";
            res.status(400).json({ error: message });
            return;
        }
        next();
    });
}

/**
 * Dependencias inyectables de los endpoints PD-07. En producción quedan
 * vacías (los servicios usan sus defaults drizzle/ffprobe/fetch); los
 * tests las pisan con store en memoria, storage en tmpdir, probe y fetch
 * falsos — el router se monta en una app express efímera sin tocar Neon.
 */
export const transmissionsRouteDeps: {
    vodUpload: VodIngestDeps;
    startLive: StartLiveDeps;
} = { vodUpload: {}, startLive: {} };

// ------------------------------------------------------------------
// Serialización fila → payload de la UI (incluye los campos del form
// derivados del RRULE + la descripción en español).
// ------------------------------------------------------------------
function serializeScheduled(row: ScheduledRow, programName: string | null) {
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        streamUrl: row.streamUrl,
        programId: row.programId,
        programName,
        rrule: row.rrule,
        rruleDescription: describeSchedule(row.rrule),
        schedule: deriveSchedule(row.rrule, row.startsAt, row.endsAt, row.timezone),
        timezone: row.timezone,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        durationMinutes: row.durationMinutes,
        autoStart: row.autoStart,
        pipelineConfig: row.pipelineConfig,
        isActive: row.isActive,
        nextRunAt: row.nextRunAt,
        lastRunAt: row.lastRunAt,
        createdAt: row.createdAt,
    };
}

async function programBelongsToTenant(tenantId: string, programId: string): Promise<boolean> {
    const [row] = await db
        .select({ id: programs.id })
        .from(programs)
        .where(and(eq(programs.id, programId), eq(programs.tenantId, tenantId)))
        .limit(1);
    return !!row;
}

async function programNameOf(programId: string | null): Promise<string | null> {
    if (!programId) return null;
    const [p] = await db
        .select({ name: programs.name })
        .from(programs)
        .where(eq(programs.id, programId))
        .limit(1);
    return p?.name ?? null;
}

async function findScheduled(tenantId: string, id: string): Promise<ScheduledRow | null> {
    const [row] = await db
        .select()
        .from(scheduledTransmissions)
        .where(and(eq(scheduledTransmissions.id, id), eq(scheduledTransmissions.tenantId, tenantId)))
        .limit(1);
    return row ?? null;
}

// ------------------------------------------------------------------
// GET /api/transmissions/scheduled?month=YYYY-MM — agenda del tenant.
// Con `month` cada item incluye `occurrences`: instantes ISO de la regla
// dentro del mes (ventana ±2 días para cubrir bordes de timezone; la UI
// bucketa por fecha local de cada entrada).
// ------------------------------------------------------------------
transmissionsRouter.get("/scheduled", requireAuth, async (req: Request, res: Response) => {
    try {
        const tenantId = req.auth!.tenantId;

        let range: { from: number; to: number } | null = null;
        const monthParam = req.query.month;
        if (monthParam !== undefined) {
            if (typeof monthParam !== "string" || !/^\d{4}-\d{2}$/.test(monthParam)) {
                res.status(400).json({ error: "month inválido: formato YYYY-MM" });
                return;
            }
            const [y, mo] = monthParam.split("-").map(Number);
            if (mo < 1 || mo > 12) {
                res.status(400).json({ error: "month inválido: formato YYYY-MM" });
                return;
            }
            range = {
                from: Date.UTC(y, mo - 1, 1) - 2 * MS_PER_DAY,
                to: Date.UTC(y, mo, 1) + 2 * MS_PER_DAY,
            };
        }

        const rows = await db
            .select({ scheduled: scheduledTransmissions, programName: programs.name })
            .from(scheduledTransmissions)
            .leftJoin(programs, eq(scheduledTransmissions.programId, programs.id))
            .where(eq(scheduledTransmissions.tenantId, tenantId))
            .orderBy(scheduledTransmissions.nextRunAt);

        const items = rows.map(({ scheduled, programName }) => {
            const item = serializeScheduled(scheduled, programName);
            if (range) {
                return {
                    ...item,
                    occurrences: occurrencesBetween(
                        scheduled.rrule,
                        scheduled.timezone,
                        scheduled.startsAt,
                        range.from,
                        range.to,
                    ).map((d) => d.toISOString()),
                };
            }
            return item;
        });

        res.json({ items });
    } catch (error) {
        console.error("[Transmissions] Error al listar la agenda:", error);
        res.status(500).json({ error: "Error al obtener la agenda" });
    }
});

// ------------------------------------------------------------------
// POST /api/transmissions/scheduled — crear una entrada de agenda.
// Recurso nuevo ⇒ suscripción activa (como POST /jobs).
// ------------------------------------------------------------------
transmissionsRouter.post(
    "/scheduled",
    requireAuth,
    requireActiveSubscription,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;

            const parsed = parseScheduleBody(req.body);
            if (parsed.error || !parsed.fields) {
                res.status(400).json({ error: parsed.error ?? "Body inválido" });
                return;
            }
            const f = parsed.fields;

            if (f.programId && !(await programBelongsToTenant(tenantId, f.programId))) {
                res.status(404).json({ error: "Programa no encontrado" });
                return;
            }

            const built = buildSchedule(f, new Date());
            if (built.error || !built.schedule) {
                res.status(400).json({ error: built.error ?? "Recurrencia inválida" });
                return;
            }

            const [row] = await db
                .insert(scheduledTransmissions)
                .values({ tenantId, ...valuesFromFields(f, built.schedule) })
                .returning();

            res.status(201).json({ item: serializeScheduled(row, await programNameOf(row.programId)) });
        } catch (error) {
            console.error("[Transmissions] Error al crear la agenda:", error);
            res.status(500).json({ error: "Error al crear la transmisión programada" });
        }
    },
);

// ------------------------------------------------------------------
// GET /api/transmissions/scheduled/:id — detalle (404 si es de otro tenant).
// ------------------------------------------------------------------
transmissionsRouter.get("/scheduled/:id", requireAuth, async (req: Request, res: Response) => {
    try {
        const tenantId = req.auth!.tenantId;
        const row = await findScheduled(tenantId, req.params.id);
        if (!row) {
            res.status(404).json({ error: "Transmisión programada no encontrada" });
            return;
        }

        res.json({ item: serializeScheduled(row, await programNameOf(row.programId)) });
    } catch (error) {
        console.error("[Transmissions] Error al obtener la agenda:", error);
        res.status(500).json({ error: "Error al obtener la transmisión programada" });
    }
});

// ------------------------------------------------------------------
// PUT /api/transmissions/scheduled/:id — actualización.
//   · Body completo (mismas validaciones que POST): recalcula rrule,
//     starts_at y next_run_at.
//   · Body `{ isActive: boolean }` solo: activa/desactiva sin tocar la
//     recurrencia (toggle de la UI).
// ------------------------------------------------------------------
transmissionsRouter.put("/scheduled/:id", requireAuth, async (req: Request, res: Response) => {
    try {
        const tenantId = req.auth!.tenantId;
        const existing = await findScheduled(tenantId, req.params.id);
        if (!existing) {
            res.status(404).json({ error: "Transmisión programada no encontrada" });
            return;
        }

        const body = req.body as Record<string, unknown> | undefined;
        const keys = body && typeof body === "object" ? Object.keys(body) : [];
        const toggleOnly = keys.length === 1 && keys[0] === "isActive";

        if (toggleOnly) {
            if (typeof body!.isActive !== "boolean") {
                res.status(400).json({ error: "isActive debe ser boolean" });
                return;
            }
            const [updated] = await db
                .update(scheduledTransmissions)
                .set({ isActive: body!.isActive })
                .where(
                    and(
                        eq(scheduledTransmissions.id, existing.id),
                        eq(scheduledTransmissions.tenantId, tenantId),
                    ),
                )
                .returning();
            res.json({ item: serializeScheduled(updated, await programNameOf(updated.programId)) });
            return;
        }

        const parsed = parseScheduleBody(req.body);
        if (parsed.error || !parsed.fields) {
            res.status(400).json({ error: parsed.error ?? "Body inválido" });
            return;
        }
        const f = parsed.fields;

        if (f.programId && !(await programBelongsToTenant(tenantId, f.programId))) {
            res.status(404).json({ error: "Programa no encontrado" });
            return;
        }

        const built = buildSchedule(f, new Date());
        if (built.error || !built.schedule) {
            res.status(400).json({ error: built.error ?? "Recurrencia inválida" });
            return;
        }

        const [updated] = await db
            .update(scheduledTransmissions)
            .set({
                ...valuesFromFields(f, built.schedule),
                isActive: f.isActive ?? existing.isActive,
            })
            .where(
                and(
                    eq(scheduledTransmissions.id, existing.id),
                    eq(scheduledTransmissions.tenantId, tenantId),
                ),
            )
            .returning();

        res.json({ item: serializeScheduled(updated, await programNameOf(updated.programId)) });
    } catch (error) {
        console.error("[Transmissions] Error al actualizar la agenda:", error);
        res.status(500).json({ error: "Error al actualizar la transmisión programada" });
    }
});

// ------------------------------------------------------------------
// DELETE /api/transmissions/scheduled/:id — borra la entrada de agenda.
// Las corridas vinculadas NO se borran: `transmissions.scheduled_transmission_id`
// y `scheduled_transmissions.last_transmission_id` tienen ON DELETE SET NULL
// en el schema ⇒ el historial queda con la FK en NULL.
// ------------------------------------------------------------------
transmissionsRouter.delete("/scheduled/:id", requireAuth, async (req: Request, res: Response) => {
    try {
        const tenantId = req.auth!.tenantId;
        const existing = await findScheduled(tenantId, req.params.id);
        if (!existing) {
            res.status(404).json({ error: "Transmisión programada no encontrada" });
            return;
        }

        await db
            .delete(scheduledTransmissions)
            .where(
                and(
                    eq(scheduledTransmissions.id, existing.id),
                    eq(scheduledTransmissions.tenantId, tenantId),
                ),
            );

        res.json({ success: true });
    } catch (error) {
        console.error("[Transmissions] Error al borrar la agenda:", error);
        res.status(500).json({ error: "Error al borrar la transmisión programada" });
    }
});

// ------------------------------------------------------------------
// POST /api/transmissions/scheduled/:id/start — disparo manual.
// Crea la corrida en `transmissions` con source='manual', status='scheduled',
// stream_url/pipeline_config/program_id heredados de la agenda, y actualiza
// last_run_at/last_transmission_id/next_run_at. Es el mismo camino que va a
// reusar el worker de auto-start (PD-03). Dispara corridas ⇒ suscripción
// activa (como POST /pipeline/start). Funciona aunque auto_start=false: el
// toggle sólo governa el disparo automático.
// ------------------------------------------------------------------
transmissionsRouter.post(
    "/scheduled/:id/start",
    requireAuth,
    requireActiveSubscription,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const scheduled = await findScheduled(tenantId, req.params.id);
            if (!scheduled) {
                res.status(404).json({ error: "Transmisión programada no encontrada" });
                return;
            }

            const now = new Date();
            const created = await db.transaction(async (tx) => {
                const [t] = await tx
                    .insert(transmissions)
                    .values({
                        tenantId,
                        programId: scheduled.programId,
                        scheduledTransmissionId: scheduled.id,
                        source: "manual",
                        status: "scheduled",
                        streamUrl: scheduled.streamUrl,
                        durationMinutes: scheduled.durationMinutes,
                        pipelineConfig: scheduled.pipelineConfig,
                    })
                    .returning();

                await tx
                    .update(scheduledTransmissions)
                    .set({
                        lastRunAt: now,
                        lastTransmissionId: t.id,
                        // Para puntual (COUNT=1) devuelve null: la única
                        // ocurrencia ya quedó consumida por este disparo.
                        nextRunAt: nextOccurrence(scheduled.rrule, now, scheduled.timezone),
                    })
                    .where(
                        and(
                            eq(scheduledTransmissions.id, scheduled.id),
                            eq(scheduledTransmissions.tenantId, tenantId),
                        ),
                    );

                return t;
            });

            res.status(201).json({ transmission: created });
        } catch (error) {
            console.error("[Transmissions] Error al disparar la transmisión:", error);
            res.status(500).json({ error: "Error al disparar la transmisión" });
        }
    },
);

// ------------------------------------------------------------------
// GET /api/transmissions — corridas del tenant ("últimas emisiones").
// Filtros: ?status=<TransmissionStatus> y ?limit= (1..200, default 50).
// ------------------------------------------------------------------
transmissionsRouter.get("/", requireAuth, async (req: Request, res: Response) => {
    try {
        const tenantId = req.auth!.tenantId;

        const status = req.query.status;
        if (status !== undefined && (typeof status !== "string" || !VALID_RUN_STATUSES.includes(status))) {
            res.status(400).json({
                error: `status inválido. Valores permitidos: ${VALID_RUN_STATUSES.join(", ")}`,
            });
            return;
        }

        let limit = DEFAULT_RUNS_LIMIT;
        if (req.query.limit !== undefined) {
            const raw = Number(req.query.limit);
            if (!Number.isInteger(raw) || raw < 1 || raw > MAX_RUNS_LIMIT) {
                res.status(400).json({ error: `limit inválido: entero 1..${MAX_RUNS_LIMIT}` });
                return;
            }
            limit = raw;
        }

        const where =
            typeof status === "string"
                ? and(eq(transmissions.tenantId, tenantId), eq(transmissions.status, status as TransmissionStatus))
                : eq(transmissions.tenantId, tenantId);

        const rows = await db
            .select({
                run: transmissions,
                programName: programs.name,
                scheduledName: scheduledTransmissions.name,
            })
            .from(transmissions)
            .leftJoin(programs, eq(transmissions.programId, programs.id))
            .leftJoin(
                scheduledTransmissions,
                eq(transmissions.scheduledTransmissionId, scheduledTransmissions.id),
            )
            .where(where)
            .orderBy(desc(transmissions.createdAt))
            .limit(limit);

        res.json({
            items: rows.map(({ run, programName, scheduledName }) => ({
                id: run.id,
                status: run.status,
                source: run.source,
                streamUrl: run.streamUrl,
                resolvedStreamUrl: run.resolvedStreamUrl,
                programId: run.programId,
                programName,
                scheduledTransmissionId: run.scheduledTransmissionId,
                scheduledName,
                durationMinutes: run.durationMinutes,
                startedAt: run.startedAt,
                endedAt: run.endedAt,
                errorMessage: run.errorMessage,
                createdAt: run.createdAt,
            })),
        });
    } catch (error) {
        console.error("[Transmissions] Error al listar corridas:", error);
        res.status(500).json({ error: "Error al obtener las transmisiones" });
    }
});

// ------------------------------------------------------------------
// GET /api/transmissions/sources — registry de fuentes soportadas (PD-07 C).
// Sirve a la UI el catálogo serializado + notas operativas: youtube
// depende de VPS/proxies por el bloqueo de datacenter (R-1) y `upload`
// es el camino recomendado para early adopters. Sin datos sensibles.
// ------------------------------------------------------------------
transmissionsRouter.get("/sources", requireAuth, (_req: Request, res: Response) => {
    res.json({
        items: STREAM_SOURCES.map(({ kind, label, supportsLive, needsResolver }) => ({
            kind,
            label,
            supportsLive,
            needsResolver,
        })),
        notes: [
            "youtube requiere VPS o proxies de salida: la plataforma bloquea IPs de datacenter (riesgo R-1).",
            "upload es el camino recomendado para early adopters mientras dure el bloqueo de YouTube.",
        ],
    });
});

// ------------------------------------------------------------------
// POST /api/transmissions/vod-upload — fallback VOD (PD-07 B).
//
//   multipart/form-data:
//     file            → el video (obligatorio salvo que venga vodUrl)
//     vodUrl          → alternativa: URL http(s) descargable del VOD
//     programId       → opcional, tiene que pertenecer al tenant (404 si no)
//     name            → opcional, rótulo del usuario (pipeline_config.name)
//     durationMinutes → opcional, entero 5..480 (rango de scheduleRules)
//     startedAt       → opcional, ISO: ancla wall-clock de la emisión
//
// El tenantId SIEMPRE sale de req.auth — jamás del body. El temporal de
// multer se borra en `finally` aunque falle la validación o el ingest.
// ------------------------------------------------------------------
transmissionsRouter.post(
    "/vod-upload",
    requireAuth,
    requireActiveSubscription,
    (req: Request, res: Response, next: () => void) => vodUploadSingle(req, res, next),
    async (req: Request, res: Response) => {
        const tenantId = req.auth!.tenantId;
        const body = (req.body ?? {}) as Record<string, unknown>;

        let tempPath: string | null = null;
        try {
            // ── 1. Adquirir el archivo: upload directo o descarga por URL ──
            let originalName: string;
            let bytes: number;
            if (req.file) {
                if (typeof body.vodUrl === "string" && body.vodUrl.trim() !== "") {
                    res.status(400).json({ error: "Enviá el archivo o `vodUrl`, no ambos" });
                    return;
                }
                tempPath = req.file.path;
                originalName = req.file.originalname;
                bytes = req.file.size;
            } else if (typeof body.vodUrl === "string" && body.vodUrl.trim() !== "") {
                const downloaded = await downloadVodToTemp(body.vodUrl.trim(), {
                    maxBytes: VOD_UPLOAD_MAX_BYTES,
                    fetchImpl: transmissionsRouteDeps.vodUpload.fetchImpl,
                });
                tempPath = downloaded.filePath;
                originalName = downloaded.fileName;
                bytes = downloaded.bytes;
            } else {
                res.status(400).json({
                    error: "Falta el archivo de video (`file` en multipart o `vodUrl`)",
                });
                return;
            }

            // ── 2. Validaciones de negocio (mensajes claros, en español) ──
            const ext = path.extname(originalName).toLowerCase();
            if (!(VOD_VIDEO_EXTENSIONS as readonly string[]).includes(ext)) {
                res.status(400).json({
                    error: `Extensión de video no soportada (${ext || "sin extensión"}). Aceptadas: ${VOD_VIDEO_EXTENSIONS.join(", ")}`,
                });
                return;
            }
            if (bytes <= 0) {
                res.status(400).json({ error: "El archivo está vacío" });
                return;
            }

            let programId: string | null = null;
            if (body.programId !== undefined && body.programId !== null && body.programId !== "") {
                if (typeof body.programId !== "string" || !UUID_RE.test(body.programId)) {
                    res.status(400).json({ error: "programId inválido" });
                    return;
                }
                programId = body.programId;
            }

            const name =
                typeof body.name === "string" && body.name.trim() !== ""
                    ? body.name.trim().slice(0, 255)
                    : null;

            let durationMinutes: number | null = null;
            if (body.durationMinutes !== undefined && body.durationMinutes !== null && body.durationMinutes !== "") {
                const n = Number(body.durationMinutes);
                if (!Number.isInteger(n) || n < MIN_DURATION_MINUTES || n > MAX_DURATION_MINUTES) {
                    res.status(400).json({
                        error: `durationMinutes tiene que ser un entero entre ${MIN_DURATION_MINUTES} y ${MAX_DURATION_MINUTES}`,
                    });
                    return;
                }
                durationMinutes = n;
            }

            let startedAt: Date | undefined;
            if (body.startedAt !== undefined && body.startedAt !== null && body.startedAt !== "") {
                const d = new Date(String(body.startedAt));
                if (Number.isNaN(d.getTime())) {
                    res.status(400).json({ error: "startedAt inválido (fecha ISO esperada)" });
                    return;
                }
                startedAt = d;
            }

            // ── 3. Ingest: probe → storage → bundle en una tx ──
            const result = await ingestVodUpload(
                {
                    tenantId,
                    filePath: tempPath,
                    originalName,
                    bytes,
                    programId,
                    name,
                    durationMinutes,
                    startedAt,
                },
                transmissionsRouteDeps.vodUpload,
            );

            if (result.videoVerified === null) {
                console.warn(
                    "[Transmissions] VOD upload: ffprobe no disponible — pista de video sin verificar",
                );
            }

            res.status(201).json({ transmission: serializeTransmission(result.transmission) });
        } catch (error) {
            if (error instanceof AppError) {
                res.status(error.statusCode).json({
                    error: error.message,
                    ...(error.code ? { code: error.code } : {}),
                });
                return;
            }
            console.error("[Transmissions] Error en el upload VOD:", error);
            res.status(500).json({ error: "Error al procesar el upload del video" });
        } finally {
            if (tempPath) {
                await fs.promises.rm(tempPath, { force: true }).catch(() => {});
            }
        }
    },
);

// ------------------------------------------------------------------
// POST /api/transmissions/start-live — disparo manual de una fuente (PD-07 D).
//
//   Body JSON: { streamUrl, programId?, scheduledTransmissionId?, durationMinutes? }
//
// Crea la corrida `live_capture`/`waiting` y responde 201. NO graba desde
// la request: el scheduler (PD-03) la toma en el próximo tick, detecta el
// live y arranca el recorder en background — decisión documentada: ni
// siquiera una llamada `void startRecording(...)` desde la ruta, porque el
// scheduler ya resuelve detección, reintentos, cap de concurrencia y cuota.
// ------------------------------------------------------------------
transmissionsRouter.post(
    "/start-live",
    requireAuth,
    requireActiveSubscription,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const body = (req.body ?? {}) as Record<string, unknown>;

            if (typeof body.streamUrl !== "string" || body.streamUrl.trim() === "") {
                res.status(400).json({ error: "streamUrl es obligatoria" });
                return;
            }

            let programId: string | null = null;
            if (body.programId !== undefined && body.programId !== null && body.programId !== "") {
                if (typeof body.programId !== "string" || !UUID_RE.test(body.programId)) {
                    res.status(400).json({ error: "programId inválido" });
                    return;
                }
                programId = body.programId;
            }

            let scheduledTransmissionId: string | null = null;
            if (
                body.scheduledTransmissionId !== undefined &&
                body.scheduledTransmissionId !== null &&
                body.scheduledTransmissionId !== ""
            ) {
                if (
                    typeof body.scheduledTransmissionId !== "string" ||
                    !UUID_RE.test(body.scheduledTransmissionId)
                ) {
                    res.status(400).json({ error: "scheduledTransmissionId inválido" });
                    return;
                }
                scheduledTransmissionId = body.scheduledTransmissionId;
            }

            let durationMinutes: number | null = null;
            if (body.durationMinutes !== undefined && body.durationMinutes !== null && body.durationMinutes !== "") {
                const n = Number(body.durationMinutes);
                if (!Number.isInteger(n)) {
                    res.status(400).json({ error: "durationMinutes inválido" });
                    return;
                }
                durationMinutes = n;
            }

            const { transmission } = await startLiveTransmission(
                {
                    tenantId,
                    streamUrl: body.streamUrl,
                    programId,
                    scheduledTransmissionId,
                    durationMinutes,
                },
                transmissionsRouteDeps.startLive,
            );

            res.status(201).json({ transmission: serializeTransmission(transmission) });
        } catch (error) {
            if (error instanceof AppError) {
                res.status(error.statusCode).json({
                    error: error.message,
                    ...(error.code ? { code: error.code } : {}),
                });
                return;
            }
            console.error("[Transmissions] Error al disparar la fuente live:", error);
            res.status(500).json({ error: "Error al disparar la transmisión" });
        }
    },
);
