import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { db } from '../db/index.js';
import { assets } from '../db/schema/index.js';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth.js';
import { signedMediaUrl } from '../services/mediaSigner.js';

// ---------------------------------------------------------------------------
// /api/assets — proxy de media privada (D13)
// GET /api/assets/:id/media?kind=video|image|thumbnail|audio|subtitles
//   → 302 a URL firmada del engine (MEDIA_ENGINE_URL set), o serve local
//   (dev/monolito: MEDIA_ROOT, luego PROJECT_ROOT como fallback legacy).
// ---------------------------------------------------------------------------

export const assetsRouter = Router();

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(dirname(__filename), '..', '..', '..');
const MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT || '/data/media');
const MEDIA_ENGINE_URL = process.env.MEDIA_ENGINE_URL || '';

const KIND_TO_KEY: Record<string, string> = {
    video: 'videoPath',
    image: 'imagePath',
    thumbnail: 'thumbnailPath',
    audio: 'audioPath',
    subtitles: 'subtitlesPath',
};

function toRelativeMediaPath(ref: string): string {
    // Path absoluto dentro de MEDIA_ROOT → relativo; resto se usa tal cual.
    if (path.isAbsolute(ref)) {
        const rel = path.relative(MEDIA_ROOT, ref);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
        return ref.replace(/^[/\\]+/, '');
    }
    return ref.replace(/^[/\\]+/, '');
}

function resolveLocalCandidates(ref: string): string[] {
    const candidates: string[] = [];
    if (path.isAbsolute(ref)) candidates.push(ref);
    candidates.push(path.resolve(MEDIA_ROOT, ref));
    candidates.push(path.resolve(PROJECT_ROOT, ref));
    return candidates;
}

// GET /api/assets/:id/media?kind=video
assetsRouter.get('/:id/media', requireAuth, async (req: Request, res: Response) => {
    try {
        const tenantId = req.auth!.tenantId;
        const assetId = String(req.params.id);
        const kind = String(req.query.kind ?? 'video');
        const refKey = KIND_TO_KEY[kind];
        if (!refKey) {
            res.status(400).json({ error: `kind inválido — usar: ${Object.keys(KIND_TO_KEY).join('|')}` });
            return;
        }

        const [asset] = await db.select({
            id: assets.id,
            mediaRefs: assets.mediaRefs,
        }).from(assets)
            .where(and(eq(assets.id, assetId), eq(assets.tenantId, tenantId)))
            .limit(1);

        if (!asset) {
            res.status(404).json({ error: 'Asset no encontrado' });
            return;
        }

        const refs = (asset.mediaRefs ?? {}) as Record<string, unknown>;
        const ref = refs[refKey];
        if (typeof ref !== 'string' || !ref) {
            res.status(404).json({ error: `El asset no tiene media '${kind}'` });
            return;
        }

        // URL externa (p.ej. CDN) → redirect directo
        if (/^https?:\/\//i.test(ref)) {
            res.redirect(ref);
            return;
        }

        // Engine configurado → redirect a URL firmada de corta vida
        if (MEDIA_ENGINE_URL) {
            const relPath = toRelativeMediaPath(ref);
            res.redirect(signedMediaUrl(MEDIA_ENGINE_URL, relPath));
            return;
        }

        // Fallback local (dev/monolito)
        const filePath = resolveLocalCandidates(ref).find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
        if (!filePath) {
            res.status(404).json({ error: 'Media no disponible en este servidor' });
            return;
        }
        res.sendFile(filePath);
    } catch (err) {
        console.error('[Assets] media proxy error:', err);
        res.status(500).json({ error: 'Error al servir media' });
    }
});
