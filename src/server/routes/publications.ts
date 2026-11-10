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
 *   POST /:id/variants → genera las variantes por red (copy + hashtags +
 *   menciones con handles REALES de persons.social_links) y las persiste
 *   en `publications.contentVariants` (PF-09).
 *   Body: { networks?: string[] } — redes a generar
 *   ('twitter'|'instagram'|'linkedin'|'youtube'|'newsletter'); ausente o
 *   [] ⇒ default de la línea editorial (o las 5 si no hay perfil).
 *   201 { publicationId, variants, mentionsResolved, generatedAt }.
 *
 * Aislamiento: el tenant sale SIEMPRE de `req.auth!.tenantId` — una
 * publicación ajena ⇒ 404 (no se distingue "no existe" de "es de otro").
 *
 * Status map (los AppError del servicio pasan con su code):
 *   400 onlyPersonsWithPhotos presente pero no boolean |
 *       networks presente pero no es array de strings
 *   404 publication_not_found
 *   422 no_quotes | no_content | invalid_network
 *   502 invalid_model_response (el modelo devolvió basura)
 *
 * Deps inyectables (`publicationsRouteDeps`): un objeto por servicio —
 * `store`/`renderFlyer`/`loadBranding`/`now` para quote-flyers (PF-07) y
 * `variantsStore`/`generate`/`editorialContext`/`now` para variants
 * (PF-09); `now` es compartido. Los tests los pisan con stores en
 * memoria y fakes deterministas (¡NUNCA canvas ni LLM real!); el router
 * se monta en una app express efímera sin tocar Neon ni @napi-rs/canvas.
 */
import { Router, type Request, type Response } from 'express';

import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../lib/errors.js';
import {
    generateQuoteFlyers,
    type GenerateQuoteFlyersDeps,
} from '../services/quoteFlyerService.js';
import {
    generateVariants,
    type GenerateVariantsDeps,
    type NetworkVariantStore,
} from '../services/networkVariantService.js';

export const publicationsRouter = Router();

/**
 * Mismo contrato que notesRouteDeps/clipsRouteDeps. `store` queda para
 * los quote-flyers; el store de variants se llama `variantsStore` porque
 * ambos objetos conviven en el mismo deps bag (mismo patrón, sin
 * colisión de nombres).
 */
export interface PublicationsRouteDeps extends GenerateQuoteFlyersDeps {
    variantsStore?: NetworkVariantStore;
    generate?: GenerateVariantsDeps['generate'];
    editorialContext?: GenerateVariantsDeps['editorialContext'];
}

export const publicationsRouteDeps: PublicationsRouteDeps = {};

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

// ------------------------------------------------------------------
// POST /api/publications/:id/variants — variantes por red con handles
// reales (PF-09).
// ------------------------------------------------------------------
publicationsRouter.post(
    '/:id/variants',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const body = (req.body ?? {}) as Record<string, unknown>;

            let networks: string[] | undefined;
            if (body.networks !== undefined && body.networks !== null) {
                if (
                    !Array.isArray(body.networks) ||
                    body.networks.some((n) => typeof n !== 'string')
                ) {
                    res.status(400).json({
                        error: 'networks debe ser un array de strings',
                    });
                    return;
                }
                networks = body.networks as string[];
            }

            const result = await generateVariants(
                {
                    tenantId,
                    publicationId: req.params.id,
                    networks,
                },
                {
                    store: publicationsRouteDeps.variantsStore,
                    generate: publicationsRouteDeps.generate,
                    editorialContext: publicationsRouteDeps.editorialContext,
                    now: publicationsRouteDeps.now,
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
            console.error('[Publications] Error al generar variantes:', error);
            res.status(500).json({ error: 'Error al generar las variantes' });
        }
    },
);
