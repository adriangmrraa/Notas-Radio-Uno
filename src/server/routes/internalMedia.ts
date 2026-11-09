import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { verifyMediaToken } from '../services/mediaSigner.js';

// ---------------------------------------------------------------------------
// /internal/media/* — sirve media privada del volumen del engine (D13).
// Auth = token firmado de corta vida (?t=exp.sig) — NO JWT: los clientes llegan
// via redirect del proxy /api/assets/:id/media o consumo interno (Zernio).
// ---------------------------------------------------------------------------

export const internalMediaRouter = Router();

const MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT || '/data/media');

const MIME_BY_EXT: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.srt': 'text/plain; charset=utf-8',
    '.ass': 'text/plain; charset=utf-8',
    '.vtt': 'text/vtt; charset=utf-8',
};

function resolveInsideRoot(relPath: string): string | null {
    if (path.isAbsolute(relPath)) return null;
    const resolved = path.resolve(MEDIA_ROOT, relPath);
    if (resolved !== MEDIA_ROOT && !resolved.startsWith(MEDIA_ROOT + path.sep)) return null;
    return resolved;
}

// GET /internal/media/{relpath}?t=<signed>
internalMediaRouter.get('/*', (req: Request, res: Response) => {
    const relPath = String(req.params[0] ?? '').replace(/^\/+/, '');
    if (!relPath || relPath.includes('\0')) {
        res.status(400).json({ error: 'Invalid media path' });
        return;
    }

    const token = req.query.t;
    if (!verifyMediaToken(relPath, typeof token === 'string' ? token : undefined)) {
        res.status(403).json({ error: 'Invalid or expired media token' });
        return;
    }

    const filePath = resolveInsideRoot(relPath);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.status(404).json({ error: 'Media not found' });
        return;
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_BY_EXT[ext] ?? 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=60');

    const range = req.headers.range;
    if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match) {
            const start = match[1] ? parseInt(match[1], 10) : 0;
            const end = match[2] ? Math.min(parseInt(match[2], 10), stat.size - 1) : stat.size - 1;
            if (start >= stat.size || start > end) {
                res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
                return;
            }
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
            res.setHeader('Content-Length', end - start + 1);
            fs.createReadStream(filePath, { start, end }).pipe(res);
            return;
        }
    }

    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(filePath).pipe(res);
});
