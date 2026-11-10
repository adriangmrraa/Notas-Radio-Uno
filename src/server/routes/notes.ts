/**
 * notes.ts — API de notas por rubro (PF-06). Montado en /api/transmissions
 * (mismo mount que transmissionsRouter: los paths son disjuntos).
 *
 *   POST /:id/notes → genera una nota del rubro pedido desde los
 *   segmentos + citas atribuidas de la transmisión y la persiste en
 *   `publications` (source='pipeline', status='pending_review').
 *   Body: { format: 'flash'|'corta'|'completa'|'cronica', programId? }.
 *   201 { publication, segmentsUsed, quotesUsed, generatedAt }.
 *
 * Aislamiento: el tenant sale SIEMPRE de `req.auth!.tenantId` — una
 * transmisión o programa ajeno ⇒ 404 (no se distingue "no existe" de
 * "es de otro").
 *
 * Status map (los AppError del servicio pasan con su code):
 *   400 body mal formado (format no string/vacío, programId no UUID)
 *   404 transmission_not_found | invalid_program
 *   422 invalid_format | no_content
 *   502 invalid_model_response (el modelo devolvió basura)
 *
 * Deps inyectables (`notesRouteDeps`): el store, `generate`, la
 * resolución editorial y el listado de citas — los tests los pisan con
 * store en memoria y generate fake; el router se monta en una app
 * express efímera sin tocar Neon ni el provider real.
 */
import { Router, type Request, type Response } from 'express';

import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../lib/errors.js';
import {
    generateNote,
    RUBRO_TEMPLATES,
    type GenerateNoteDeps,
    type NoteRubro,
} from '../services/noteFactoryService.js';

export const notesRouter = Router();

/** Mismo contrato que liveRouteDeps/transmissionsRouteDeps. */
export const notesRouteDeps: GenerateNoteDeps = {};

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------
// POST /api/transmissions/:id/notes — nota por rubro con citas atribuidas.
// ------------------------------------------------------------------
notesRouter.post(
    '/:id/notes',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const body = (req.body ?? {}) as Record<string, unknown>;

            const format = body.format;
            if (typeof format !== 'string' || format.trim() === '') {
                res.status(400).json({
                    error: 'format es obligatorio (string)',
                });
                return;
            }
            const rubro = format.trim();
            if (!(rubro in RUBRO_TEMPLATES)) {
                res.status(422).json({
                    error: `Rubro inválido: '${rubro}'`,
                    code: 'invalid_format',
                });
                return;
            }

            let programId: string | null = null;
            if (
                body.programId !== undefined &&
                body.programId !== null &&
                body.programId !== ''
            ) {
                if (
                    typeof body.programId !== 'string' ||
                    !UUID_RE.test(body.programId)
                ) {
                    res.status(400).json({ error: 'programId inválido' });
                    return;
                }
                programId = body.programId;
            }

            const result = await generateNote(
                {
                    tenantId,
                    transmissionId: req.params.id,
                    format: rubro as NoteRubro,
                    programId,
                },
                notesRouteDeps,
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
            console.error('[Notes] Error al generar la nota:', error);
            res.status(500).json({ error: 'Error al generar la nota' });
        }
    },
);
