import { Router, Request, Response } from 'express';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import crypto from 'crypto';
import { socialPortfolios, businessAssets, subscriptions, plans, credentials } from '../db/schema/index.js';
import { eq, and, sql } from 'drizzle-orm';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/connections/portfolios — List all portfolios with assets
// ---------------------------------------------------------------------------
router.get('/portfolios', requireAuth, async (req: Request, res: Response) => {
    try {
        const tenantId = req.auth!.tenantId;

        const portfolioRows = await db.select().from(socialPortfolios)
            .where(eq(socialPortfolios.tenantId, tenantId))
            .orderBy(socialPortfolios.sortOrder);

        // Fetch active assets for each portfolio
        const assetRows = await db.select().from(businessAssets)
            .where(and(
                eq(businessAssets.tenantId, tenantId),
                eq(businessAssets.isActive, true)
            ));

        // Group assets by portfolioId
        const assetsByPortfolio = new Map<string, typeof assetRows>();
        for (const asset of assetRows) {
            if (!asset.portfolioId) continue;
            if (!assetsByPortfolio.has(asset.portfolioId)) {
                assetsByPortfolio.set(asset.portfolioId, []);
            }
            assetsByPortfolio.get(asset.portfolioId)!.push(asset);
        }

        const result = portfolioRows.map((p) => ({
            ...p,
            assets: assetsByPortfolio.get(p.id) || [],
        }));

        res.json(result);
    } catch (err) {
        console.error('[Connections] Error:', err);
        res.status(500).json({ error: 'Error al obtener portfolios' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/connections/portfolios — Create portfolio
// ---------------------------------------------------------------------------
router.post('/portfolios', requireAuth, async (req: Request, res: Response) => {
    try {
        const tenantId = req.auth!.tenantId;
        const { name } = req.body;

        if (!name?.trim()) {
            res.status(400).json({ error: 'Nombre requerido' });
            return;
        }

        // Check plan limit
        const [subRow] = await db.select({ sub: subscriptions, plan: plans })
            .from(subscriptions)
            .leftJoin(plans, eq(subscriptions.planId, plans.id))
            .where(eq(subscriptions.tenantId, tenantId))
            .limit(1);
        const maxPortfolios = subRow?.plan?.maxConnectedPlatforms ?? 2;

        const countResult = await db.select({ count: sql<number>`count(*)` })
            .from(socialPortfolios)
            .where(eq(socialPortfolios.tenantId, tenantId));
        const currentCount = Number(countResult[0]?.count ?? 0);

        if (maxPortfolios !== -1 && currentCount >= maxPortfolios) {
            res.status(403).json({
                error: `Tu plan permite maximo ${maxPortfolios} portfolios. Actualiza tu plan.`,
                code: 'PORTFOLIO_LIMIT',
            });
            return;
        }

        const [portfolio] = await db.insert(socialPortfolios).values({
            tenantId,
            name: name.trim(),
            sortOrder: currentCount,
        }).returning();

        res.status(201).json({ ...portfolio, assets: [] });
    } catch (err: any) {
        // Unique constraint violation
        if (err.code === '23505' || err.code === 'P2002') {
            res.status(409).json({ error: 'Ya existe un portfolio con ese nombre' });
            return;
        }
        console.error('[Connections] Create error:', err);
        res.status(500).json({ error: 'Error al crear portfolio' });
    }
});

// ---------------------------------------------------------------------------
// DELETE /api/connections/portfolios/:id — Delete portfolio + assets
// ---------------------------------------------------------------------------
router.delete('/portfolios/:id', requireAuth, async (req: Request, res: Response) => {
    try {
        const [portfolio] = await db.select().from(socialPortfolios)
            .where(and(
                eq(socialPortfolios.id, req.params.id),
                eq(socialPortfolios.tenantId, req.auth!.tenantId)
            ))
            .limit(1);
        if (!portfolio) {
            res.status(404).json({ error: 'Portfolio no encontrado' });
            return;
        }

        // Deactivate assets, then delete portfolio
        await db.update(businessAssets)
            .set({ isActive: false, portfolioId: null })
            .where(eq(businessAssets.portfolioId, portfolio.id));

        await db.delete(socialPortfolios)
            .where(eq(socialPortfolios.id, portfolio.id));

        res.json({ success: true });
    } catch (err) {
        console.error('[Connections] Delete error:', err);
        res.status(500).json({ error: 'Error al eliminar portfolio' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/connections/portfolios/:id/meta — Connect Meta to portfolio
// ---------------------------------------------------------------------------
router.post('/portfolios/:id/meta', requireAuth, async (req: Request, res: Response) => {
    try {
        const tenantId = req.auth!.tenantId;
        const portfolioId = req.params.id;
        const { accessToken, code } = req.body;

        const [portfolio] = await db.select().from(socialPortfolios)
            .where(and(
                eq(socialPortfolios.id, portfolioId),
                eq(socialPortfolios.tenantId, tenantId)
            ))
            .limit(1);
        if (!portfolio) {
            res.status(404).json({ error: 'Portfolio no encontrado' });
            return;
        }

        // Exchange for long-lived token
        let userToken = accessToken;
        if (code) {
            const appId = process.env.META_APP_ID;
            const appSecret = process.env.META_APP_SECRET;
            const resp = await fetch(
                `https://graph.facebook.com/v22.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${code}&redirect_uri=${encodeURIComponent(process.env.FRONTEND_URL || 'http://localhost:5173')}`
            );
            const data = await resp.json() as any;
            userToken = data.access_token;
        }

        if (!userToken) {
            res.status(400).json({ error: 'Token o code requerido' });
            return;
        }

        // Exchange short-lived for long-lived token
        const appId = process.env.META_APP_ID;
        const appSecret = process.env.META_APP_SECRET;
        const llResp = await fetch(
            `https://graph.facebook.com/v22.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${userToken}`
        );
        const llData = await llResp.json() as any;
        const longLivedToken = llData.access_token || userToken;
        const expiresIn = llData.expires_in || 5184000; // 60 days

        // Store user token
        await db.insert(credentials).values({
            tenantId,
            name: `META_TOKEN_${portfolioId}`,
            value: longLivedToken,
            category: 'meta',
            isValid: true,
        }).onConflictDoUpdate({
            target: [credentials.tenantId, credentials.name],
            set: { value: longLivedToken, isValid: true },
        });

        await db.insert(credentials).values({
            tenantId,
            name: `META_EXPIRES_${portfolioId}`,
            value: new Date(Date.now() + expiresIn * 1000).toISOString(),
            category: 'meta',
        }).onConflictDoUpdate({
            target: [credentials.tenantId, credentials.name],
            set: { value: new Date(Date.now() + expiresIn * 1000).toISOString() },
        });

        // Discover pages
        const pagesResp = await fetch(`https://graph.facebook.com/v22.0/me/accounts?access_token=${longLivedToken}`);
        const pagesData = await pagesResp.json() as any;
        const pages = pagesData.data || [];

        const assets = [];
        for (const page of pages) {
            const [asset] = await db.insert(businessAssets).values({
                tenantId,
                portfolioId,
                assetType: 'facebook_page',
                externalId: page.id,
                name: page.name,
                metadata: { pageAccessToken: page.access_token },
                isActive: true,
            }).onConflictDoUpdate({
                target: [businessAssets.tenantId, businessAssets.externalId],
                set: {
                    name: page.name,
                    portfolioId,
                    isActive: true,
                    metadata: { pageAccessToken: page.access_token },
                },
            }).returning();
            assets.push(asset);

            // Check for linked Instagram
            const igResp = await fetch(`https://graph.facebook.com/v22.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`);
            const igData = await igResp.json() as any;
            if (igData.instagram_business_account?.id) {
                const igId = igData.instagram_business_account.id;
                const igInfoResp = await fetch(`https://graph.facebook.com/v22.0/${igId}?fields=name,username,profile_picture_url&access_token=${page.access_token}`);
                const igInfo = await igInfoResp.json() as any;

                const [igAsset] = await db.insert(businessAssets).values({
                    tenantId,
                    portfolioId,
                    assetType: 'instagram_account',
                    externalId: igId,
                    name: igInfo.username || igInfo.name,
                    metadata: { username: igInfo.username, linkedPageId: page.id },
                    isActive: true,
                }).onConflictDoUpdate({
                    target: [businessAssets.tenantId, businessAssets.externalId],
                    set: {
                        name: igInfo.username || igInfo.name,
                        portfolioId,
                        isActive: true,
                        metadata: { username: igInfo.username, linkedPageId: page.id },
                    },
                }).returning();
                assets.push(igAsset);
            }
        }

        res.json({ success: true, assets, expiresAt: new Date(Date.now() + expiresIn * 1000) });
    } catch (err) {
        console.error('[Connections] Meta connect error:', err);
        res.status(500).json({ error: 'Error al conectar Meta' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/connections/portfolios/:id/twitter — Connect Twitter via OAuth2 PKCE
// ---------------------------------------------------------------------------
router.post('/portfolios/:id/twitter', requireAuth, async (req: Request, res: Response) => {
    try {
        const tenantId = req.auth!.tenantId;
        const portfolioId = req.params.id;
        const { code, codeVerifier, redirectUri } = req.body;

        const [portfolio] = await db.select().from(socialPortfolios)
            .where(and(
                eq(socialPortfolios.id, portfolioId),
                eq(socialPortfolios.tenantId, tenantId)
            ))
            .limit(1);
        if (!portfolio) {
            res.status(404).json({ error: 'Portfolio no encontrado' });
            return;
        }

        const clientId = process.env.TWITTER_CLIENT_ID;
        if (!clientId) {
            res.status(503).json({ error: 'Twitter OAuth no configurado' });
            return;
        }

        // Exchange code for access token (OAuth2 PKCE — no client secret needed)
        const tokenResp = await fetch('https://api.twitter.com/2/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
                client_id: clientId,
                code_verifier: codeVerifier,
            }),
        });
        const tokenData = await tokenResp.json() as any;

        if (!tokenData.access_token) {
            res.status(400).json({ error: 'Error al obtener token de Twitter', detail: tokenData });
            return;
        }

        // Get user info
        const userResp = await fetch('https://api.twitter.com/2/users/me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const userData = await userResp.json() as any;
        const twitterUser = userData.data;

        // Store tokens
        await db.insert(credentials).values({
            tenantId,
            name: `TWITTER_TOKEN_${portfolioId}`,
            value: tokenData.access_token,
            category: 'twitter',
            isValid: true,
        }).onConflictDoUpdate({
            target: [credentials.tenantId, credentials.name],
            set: { value: tokenData.access_token, isValid: true },
        });

        if (tokenData.refresh_token) {
            await db.insert(credentials).values({
                tenantId,
                name: `TWITTER_REFRESH_${portfolioId}`,
                value: tokenData.refresh_token,
                category: 'twitter',
            }).onConflictDoUpdate({
                target: [credentials.tenantId, credentials.name],
                set: { value: tokenData.refresh_token },
            });
        }

        // Create asset
        const [asset] = await db.insert(businessAssets).values({
            tenantId,
            portfolioId,
            assetType: 'twitter_account',
            externalId: twitterUser?.id || 'unknown',
            name: `@${twitterUser?.username}`,
            metadata: { username: twitterUser?.username, name: twitterUser?.name },
            isActive: true,
        }).onConflictDoUpdate({
            target: [businessAssets.tenantId, businessAssets.externalId],
            set: {
                name: `@${twitterUser?.username}`,
                portfolioId,
                isActive: true,
                metadata: { username: twitterUser?.username, name: twitterUser?.name },
            },
        }).returning();

        res.json({ success: true, asset, user: twitterUser });
    } catch (err) {
        console.error('[Connections] Twitter connect error:', err);
        res.status(500).json({ error: 'Error al conectar Twitter' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/connections/twitter/auth-url — Generate Twitter OAuth2 PKCE URL
// ---------------------------------------------------------------------------
router.get('/twitter/auth-url', requireAuth, (_req: Request, res: Response) => {
    const clientId = process.env.TWITTER_CLIENT_ID;
    if (!clientId) {
        res.status(503).json({ error: 'Twitter OAuth no configurado' });
        return;
    }

    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    const redirectUri = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/connections/twitter/callback`;

    const authUrl = `https://twitter.com/i/oauth2/authorize?` + new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'tweet.read tweet.write users.read offline.access',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
    }).toString();

    res.json({ authUrl, codeVerifier, state, redirectUri });
});

// ---------------------------------------------------------------------------
// DELETE /api/connections/assets/:id — Disconnect individual asset
// ---------------------------------------------------------------------------
router.delete('/assets/:id', requireAuth, async (req: Request, res: Response) => {
    try {
        const [asset] = await db.select().from(businessAssets)
            .where(and(
                eq(businessAssets.id, req.params.id),
                eq(businessAssets.tenantId, req.auth!.tenantId)
            ))
            .limit(1);
        if (!asset) {
            res.status(404).json({ error: 'Asset no encontrado' });
            return;
        }

        await db.update(businessAssets)
            .set({ isActive: false })
            .where(eq(businessAssets.id, asset.id));

        res.json({ success: true });
    } catch (err) {
        console.error('[Connections] Disconnect error:', err);
        res.status(500).json({ error: 'Error al desconectar' });
    }
});

export { router as connectionsRouter };
