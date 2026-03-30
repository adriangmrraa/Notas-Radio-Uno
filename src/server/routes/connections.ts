import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import crypto from 'crypto';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/connections/portfolios — List all portfolios with assets
// ---------------------------------------------------------------------------
router.get('/portfolios', requireAuth, async (req: Request, res: Response) => {
    try {
        const portfolios = await prisma.socialPortfolio.findMany({
            where: { tenantId: req.auth!.tenantId },
            include: { assets: { where: { isActive: true } } },
            orderBy: { sortOrder: 'asc' },
        });
        res.json(portfolios);
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
        const subscription = await prisma.subscription.findUnique({
            where: { tenantId },
            include: { plan: true },
        });
        const maxPortfolios = subscription?.plan?.maxConnectedPlatforms ?? 2;
        const currentCount = await prisma.socialPortfolio.count({ where: { tenantId } });

        if (maxPortfolios !== -1 && currentCount >= maxPortfolios) {
            res.status(403).json({
                error: `Tu plan permite maximo ${maxPortfolios} portfolios. Actualiza tu plan.`,
                code: 'PORTFOLIO_LIMIT',
            });
            return;
        }

        const portfolio = await prisma.socialPortfolio.create({
            data: { tenantId, name: name.trim(), sortOrder: currentCount },
            include: { assets: true },
        });

        res.status(201).json(portfolio);
    } catch (err: any) {
        if (err.code === 'P2002') {
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
        const portfolio = await prisma.socialPortfolio.findFirst({
            where: { id: req.params.id as string, tenantId: req.auth!.tenantId },
        });
        if (!portfolio) {
            res.status(404).json({ error: 'Portfolio no encontrado' });
            return;
        }

        // Deactivate assets, then delete portfolio
        await prisma.businessAsset.updateMany({
            where: { portfolioId: portfolio.id },
            data: { isActive: false, portfolioId: null },
        });
        await prisma.socialPortfolio.delete({ where: { id: portfolio.id } });

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
        const portfolioId = req.params.id as string;
        const { accessToken, code } = req.body;

        const portfolio = await prisma.socialPortfolio.findFirst({
            where: { id: portfolioId, tenantId },
        });
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
        await prisma.credential.upsert({
            where: { tenantId_name: { tenantId, name: `META_TOKEN_${portfolioId}` } },
            update: { value: longLivedToken, isValid: true },
            create: { tenantId, name: `META_TOKEN_${portfolioId}`, value: longLivedToken, category: 'meta' },
        });
        await prisma.credential.upsert({
            where: { tenantId_name: { tenantId, name: `META_EXPIRES_${portfolioId}` } },
            update: { value: new Date(Date.now() + expiresIn * 1000).toISOString() },
            create: { tenantId, name: `META_EXPIRES_${portfolioId}`, value: new Date(Date.now() + expiresIn * 1000).toISOString(), category: 'meta' },
        });

        // Discover pages
        const pagesResp = await fetch(`https://graph.facebook.com/v22.0/me/accounts?access_token=${longLivedToken}`);
        const pagesData = await pagesResp.json() as any;
        const pages = pagesData.data || [];

        const assets = [];
        for (const page of pages) {
            const asset = await prisma.businessAsset.upsert({
                where: { tenantId_externalId: { tenantId, externalId: page.id } },
                update: { name: page.name, portfolioId, isActive: true, metadata: { pageAccessToken: page.access_token } },
                create: {
                    tenantId, portfolioId, assetType: 'facebook_page',
                    externalId: page.id, name: page.name,
                    metadata: { pageAccessToken: page.access_token },
                },
            });
            assets.push(asset);

            // Check for linked Instagram
            const igResp = await fetch(`https://graph.facebook.com/v22.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`);
            const igData = await igResp.json() as any;
            if (igData.instagram_business_account?.id) {
                const igId = igData.instagram_business_account.id;
                const igInfoResp = await fetch(`https://graph.facebook.com/v22.0/${igId}?fields=name,username,profile_picture_url&access_token=${page.access_token}`);
                const igInfo = await igInfoResp.json() as any;

                const igAsset = await prisma.businessAsset.upsert({
                    where: { tenantId_externalId: { tenantId, externalId: igId } },
                    update: { name: igInfo.username || igInfo.name, portfolioId, isActive: true, metadata: { username: igInfo.username, linkedPageId: page.id } },
                    create: {
                        tenantId, portfolioId, assetType: 'instagram_account',
                        externalId: igId, name: igInfo.username || igInfo.name,
                        metadata: { username: igInfo.username, linkedPageId: page.id },
                    },
                });
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
        const portfolioId = req.params.id as string;
        const { code, codeVerifier, redirectUri } = req.body;

        const portfolio = await prisma.socialPortfolio.findFirst({
            where: { id: portfolioId, tenantId },
        });
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
        await prisma.credential.upsert({
            where: { tenantId_name: { tenantId, name: `TWITTER_TOKEN_${portfolioId}` } },
            update: { value: tokenData.access_token, isValid: true },
            create: { tenantId, name: `TWITTER_TOKEN_${portfolioId}`, value: tokenData.access_token, category: 'twitter' },
        });

        if (tokenData.refresh_token) {
            await prisma.credential.upsert({
                where: { tenantId_name: { tenantId, name: `TWITTER_REFRESH_${portfolioId}` } },
                update: { value: tokenData.refresh_token },
                create: { tenantId, name: `TWITTER_REFRESH_${portfolioId}`, value: tokenData.refresh_token, category: 'twitter' },
            });
        }

        // Create asset
        const asset = await prisma.businessAsset.upsert({
            where: { tenantId_externalId: { tenantId, externalId: twitterUser?.id || 'unknown' } },
            update: { name: `@${twitterUser?.username}`, portfolioId, isActive: true, metadata: { username: twitterUser?.username, name: twitterUser?.name } },
            create: {
                tenantId, portfolioId, assetType: 'twitter_account',
                externalId: twitterUser?.id || 'unknown',
                name: `@${twitterUser?.username}`,
                metadata: { username: twitterUser?.username, name: twitterUser?.name },
            },
        });

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
        const asset = await prisma.businessAsset.findFirst({
            where: { id: req.params.id as string, tenantId: req.auth!.tenantId },
        });
        if (!asset) {
            res.status(404).json({ error: 'Asset no encontrado' });
            return;
        }

        await prisma.businessAsset.update({
            where: { id: asset.id },
            data: { isActive: false },
        });

        res.json({ success: true });
    } catch (err) {
        console.error('[Connections] Disconnect error:', err);
        res.status(500).json({ error: 'Error al desconectar' });
    }
});

export { router as connectionsRouter };
