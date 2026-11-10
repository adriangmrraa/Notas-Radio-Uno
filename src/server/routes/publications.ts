/**
 * publications.ts — API de publicaciones. Montado en /api/publications.
 *
 *   POST /:id/quote-flyers → genera los quote-cards 1080x1080 de las citas
 *   atribuidas persistidas en `publications.quotes` (PF-06), con la foto
 *   REAL de cada persona desde `person_photos`, y appendea los paths a
 *   `quote_flyer_paths` (PF-07).
 *   Body: { onlyPersonsWithPhotos?: boolean } (default false — sin foto el
 *   flyer igual se genera con photoData=null; nunca placeholder).
 *   201 { publicationId, flyers: [{quoteIndex, personId, path}], skipped,
 *        generatedAt }.
 *
 * Aislamiento: el tenant sale SIEMPRE de `req.auth!.tenantId` — una
 * publicación ajena ⇒ 404 (no se distingue "no existe" de "es de otro").
 *
 * Status map (los AppError del servicio pasan con su code):
 *   400 onlyPersonsWithPhotos presente pero no boolean
 *   404 publication_not_found
 *   422 no_quotes
 *
 * Deps inyectables (`publicationsRouteDeps`): el store, el render del
 * flyer y el branding — los tests los pisan con store en memoria y
 * renderFlyer fake (¡NUNCA el canvas real!); el router se monta en una app
 * express efímera sin tocar Neon ni @napi-rs/canvas.
 */
import { Router, type Request, type Response } from 'express';

import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../lib/errors.js';
import {
    generateQuoteFlyers,
    type GenerateQuoteFlyersDeps,
} from '../services/quoteFlyerService.js';

export const publicationsRouter = Router();

/** Mismo contrato que notesRouteDeps/clipsRouteDeps. */
export const publicationsRouteDeps: GenerateQuoteFlyersDeps = {};

// ------------------------------------------------------------------
// POST /api/publications/:id/quote-flyers — quote-cards con foto real.
// ------------------------------------------------------------------
publicationsRouter.post(
    '/:id/quote-flyers',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const body = (req.body ?? {}) as Record<string, unknown>;

            let onlyPersonsWithPhotos = false;
            if (
                body.onlyPersonsWithPhotos !== undefined &&
                body.onlyPersonsWithPhotos !== null
            ) {
                if (typeof body.onlyPersonsWithPhotos !== 'boolean') {
                    res.status(400).json({
                        error: 'onlyPersonsWithPhotos debe ser boolean',
                    });
                    return;
                }
                onlyPersonsWithPhotos = body.onlyPersonsWithPhotos;
            }

            const result = await generateQuoteFlyers(
                {
                    tenantId,
                    publicationId: req.params.id,
                    onlyPersonsWithPhotos,
                },
                publicationsRouteDeps,
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
            console.error('[Publications] Error al generar quote-flyers:', error);
            res.status(500).json({ error: 'Error al generar los quote-flyers' });
        }
    },
);
