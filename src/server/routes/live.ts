/**
 * live.ts — API de la Sala "En vivo" (PD-05). Montado en /api/live.
 *
 *   GET    /transmissions/:id        → estado completo de la sala.
 *   POST   /transmissions/:id/mark   → mark manual (clip de ventana / nota).
 *   POST   /transmissions/:id/stop   → finalizar la transmisión (vía FSM).
 *
 * Aislamiento: TODA query filtra por `req.auth!.tenantId` — el tenant nunca
 * viene del body. Un id ajeno al tenant ⇒ 404 (no se distingue "no existe"
 * de "es de otro").
 *
 * Deps inyectables (`liveRouteDeps`): el store de la sala y el runner de la
 * FSM — los tests los pisan con stores en memoria y el
 * `createMemoryTransitionRunner` de tests/helpers.
 */
import { Router, type Request, type Response } from 'express';

import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../lib/errors.js';
import {
    createDrizzleLiveRoomStore,
    createManualMark,
    getLiveRoomState,
    MARK_TYPES,
    MAX_MARK_WINDOW_SECONDS,
    type LiveRoomStore,
    type MarkType,
} from '../services/liveRoomService.js';
import {
    transitionTransmission,
    type TransitionRunner,
} from '../services/transmissionService.js';
import type { TransmissionStatus } from '../db/schema/enums.js';

export const liveRouter = Router();

/**
 * Dependencias inyectables de los endpoints de la sala. En producción quedan
 * vacías (los servicios usan sus defaults drizzle); los tests las pisan con
 * stores en memoria — el router se monta en una app express efímera sin
 * tocar Neon.
 */
export const liveRouteDeps: {
    store?: LiveRoomStore;
    transition?: TransitionRunner;
    now?: () => Date;
} = {};

// ------------------------------------------------------------------
// GET /api/live/transmissions/:id — payload completo de la sala.
//   { transmission, recording, segments, timeline, moments, clips, people }
// ------------------------------------------------------------------
liveRouter.get(
    '/transmissions/:id',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const state = await getLiveRoomState(tenantId, req.params.id, {
                store: liveRouteDeps.store,
            });
            if (!state) {
                res.status(404).json({ error: 'Transmisión no encontrada' });
                return;
            }
            res.json(state);
        } catch (error) {
            console.error('[Live] Error al obtener la sala:', error);
            res.status(500).json({ error: 'Error al obtener la sala en vivo' });
        }
    },
);

// ------------------------------------------------------------------
// POST /api/live/transmissions/:id/mark — mark manual.
//   Body: { type: 'clip' | 'note', windowSeconds?: number, title?: string }
//   'clip' → momento kind='mark' (reason 'mark manual') + clip 'generating'
//            con la ventana [nowMs-window, nowMs] en metadata, vinculados
//            por clip_id. 201 con { moment, clip }.
//   'note' → momento kind='mark' sin clip_id, con title. 201 con { moment }.
//   Guardias: transmisión del tenant (404), status 'live' (409) y
//   started_at presente (409) — sin ancla no hay eje temporal.
// ------------------------------------------------------------------
liveRouter.post(
    '/transmissions/:id/mark',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const body = (req.body ?? {}) as Record<string, unknown>;

            const type = body.type;
            if (typeof type !== 'string' || !(MARK_TYPES as readonly string[]).includes(type)) {
                res.status(400).json({
                    error: `type inválido. Valores permitidos: ${MARK_TYPES.join(', ')}`,
                });
                return;
            }

            let windowSeconds: number | undefined;
            if (body.windowSeconds !== undefined && body.windowSeconds !== null) {
                const n = Number(body.windowSeconds);
                if (!Number.isInteger(n) || n < 1 || n > MAX_MARK_WINDOW_SECONDS) {
                    res.status(400).json({
                        error: `windowSeconds tiene que ser un entero entre 1 y ${MAX_MARK_WINDOW_SECONDS}`,
                    });
                    return;
                }
                windowSeconds = n;
            }

            const title =
                typeof body.title === 'string' && body.title.trim() !== ''
                    ? body.title.trim().slice(0, 255)
                    : undefined;

            const result = await createManualMark(
                {
                    tenantId,
                    transmissionId: req.params.id,
                    type: type as MarkType,
                    windowSeconds,
                    title,
                },
                {
                    store: liveRouteDeps.store,
                    now: liveRouteDeps.now,
                },
            );

            res.status(201).json(result);
        } catch (error) {
            if (error instanceof AppError) {
                res.status(error.statusCode).json({
                    error: error.message,
                    ...(error.code ? { code: error.code } : {}),
                });
                return;
            }
            console.error('[Live] Error en el mark manual:', error);
            res.status(500).json({ error: 'Error al registrar el mark' });
        }
    },
);

// ------------------------------------------------------------------
// POST /api/live/transmissions/:id/stop — finalizar la transmisión.
//   Body opcional: { reason?: string }.
//
//   Decisión de destino según el estado actual (la FSM es la única puerta —
//   nunca un UPDATE directo):
//     live               → 'processing' (finalización normal: el postproceso
//                          de la corrida sigue su curso).
//     scheduled|waiting  → 'canceled' (nunca hubo señal: se cancela, no se
//                          procesa).
//     processing|done|error|canceled → 409 (ya finalizó o está finalizando).
//
//   `reason` se acepta por compatibilidad de contrato; no hay columna donde
//   persistirlo — queda fuera del UPDATE de la FSM a propósito.
// ------------------------------------------------------------------
liveRouter.post(
    '/transmissions/:id/stop',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const transition =
                liveRouteDeps.transition ?? transitionTransmission;
            const store = liveRouteDeps.store ?? createDrizzleLiveRoomStore();

            // El estado actual define el destino de la arista. El lookup
            // tenant-scoped mantiene la regla "id ajeno ⇒ 404".
            const current = await store.findTransmission(
                tenantId,
                req.params.id,
            );
            if (!current) {
                res.status(404).json({ error: 'Transmisión no encontrada' });
                return;
            }

            const target: TransmissionStatus | null =
                current.status === 'live'
                    ? 'processing'
                    : current.status === 'scheduled' ||
                        current.status === 'waiting'
                      ? 'canceled'
                      : null;

            if (!target) {
                res.status(409).json({
                    error: `La transmisión ya está en estado '${current.status}': no se puede finalizar`,
                });
                return;
            }

            const result = await transition({
                tenantId,
                transmissionId: req.params.id,
                to: target,
            });
            if (!result.ok) {
                // La FSM rechazó (estado cambió entre el lookup y la
                // transición, o arista inválida): se reporta como conflicto.
                res.status(409).json({
                    error: result.reason ?? 'Transición no permitida',
                });
                return;
            }

            res.json({ transmission: result.transmission });
        } catch (error) {
            console.error('[Live] Error al finalizar la transmisión:', error);
            res.status(500).json({ error: 'Error al finalizar la transmisión' });
        }
    },
);
