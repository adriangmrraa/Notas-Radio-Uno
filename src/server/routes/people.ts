import type { Express, Request, Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';

import { requireAuth } from '../middleware/auth.js';
import * as personService from '../services/personService.js';
import type { PersonRole } from '../db/schema/people.js';
import { personRoleValues } from '../db/schema/people.js';

// ---------------------------------------------------------------------------
// /api/people — biblioteca unificada de personas (T-27, spec people-directory)
// CRUD + fotos (multipart) + links a programas y transmisiones.
// Soft delete via is_active. Todo tenant-scoped.
// ---------------------------------------------------------------------------

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: personService.MAX_PHOTOS_PER_PERSON },
    fileFilter: (_req, file, cb) => {
        if (['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Solo se aceptan imágenes PNG, JPEG o WebP'));
        }
    },
});

function asRole(v: unknown): PersonRole | null {
    if (typeof v !== 'string' || !v.trim()) return null;
    return (personRoleValues as readonly string[]).includes(v) ? (v as PersonRole) : null;
}

export function registerPeopleRoutes(app: Express): void {
    // ------------------------------------------------------------------
    // GET /api/people — lista (filtros: programId, includeInactive, role)
    // ------------------------------------------------------------------
    app.get('/api/people', requireAuth, async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const { programId, includeInactive, role } = req.query as Record<string, string | undefined>;

            const people = await personService.list(tenantId, {
                programId: programId || undefined,
                includeInactive: includeInactive === 'true',
                role: asRole(role) ?? undefined,
            });

            const linkMap = await personService.listProgramLinks(people.map((p) => p.id));
            const out = await Promise.all(people.map(async (p) => ({
                ...p,
                programIds: linkMap.get(p.id) ?? [],
                photos: await personService.listPhotos(p.id),
            })));
            res.json({ people: out });
        } catch (error) {
            console.error('[People] list error:', error);
            res.status(500).json({ error: 'Error al listar personas' });
        }
    });

    // ------------------------------------------------------------------
    // POST /api/people — crear
    // ------------------------------------------------------------------
    app.post('/api/people', requireAuth, async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const body = req.body as {
                name?: string; role?: string; bio?: string;
                socials?: Record<string, unknown>; notes?: string;
                consentAt?: string | boolean; programIds?: string[];
            };
            if (!body.name?.trim()) {
                res.status(400).json({ error: 'El nombre es requerido' });
                return;
            }
            if (body.role && !asRole(body.role)) {
                res.status(400).json({ error: `Rol inválido. Válidos: ${personRoleValues.join(', ')}` });
                return;
            }

            const person = await personService.create(tenantId, {
                name: body.name,
                role: asRole(body.role),
                bio: body.bio ?? null,
                socials: body.socials ?? {},
                notes: body.notes ?? null,
                consentAt: body.consentAt ?? null,
                programIds: body.programIds,
            }, req.auth!.userId);

            res.status(201).json({ success: true, person: { ...person, photos: [], programIds: body.programIds ?? [] } });
        } catch (error) {
            console.error('[People] create error:', error);
            res.status(500).json({ error: 'Error al crear la persona' });
        }
    });

    // ------------------------------------------------------------------
    // GET /api/people/:id — detalle con fotos + programas
    // ------------------------------------------------------------------
    app.get('/api/people/:id', requireAuth, async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const person = await personService.getById(tenantId, String(req.params.id));
            if (!person) {
                res.status(404).json({ error: 'Persona no encontrada' });
                return;
            }
            const linkMap = await personService.listProgramLinks([person.id]);
            const photos = await personService.listPhotos(person.id);
            res.json({ person: { ...person, photos, programIds: linkMap.get(person.id) ?? [] } });
        } catch (error) {
            console.error('[People] get error:', error);
            res.status(500).json({ error: 'Error al obtener la persona' });
        }
    });

    // ------------------------------------------------------------------
    // PUT /api/people/:id — update parcial (+ programIds si vienen)
    // ------------------------------------------------------------------
    app.put('/api/people/:id', requireAuth, async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const body = req.body as {
                name?: string; role?: string | null; bio?: string | null;
                socials?: Record<string, unknown>; notes?: string | null;
                consentAt?: string | boolean | null; isActive?: boolean;
                programIds?: string[];
            };
            if (body.role !== undefined && body.role !== null && !asRole(body.role)) {
                res.status(400).json({ error: `Rol inválido. Válidos: ${personRoleValues.join(', ')}` });
                return;
            }

            const updated = await personService.update(tenantId, String(req.params.id), {
                name: body.name,
                role: body.role === undefined ? undefined : asRole(body.role),
                bio: body.bio,
                socials: body.socials,
                notes: body.notes,
                consentAt: body.consentAt,
                isActive: body.isActive,
                programIds: body.programIds,
            }, req.auth!.userId);

            if (!updated) {
                res.status(404).json({ error: 'Persona no encontrada' });
                return;
            }
            res.json({ success: true, person: updated });
        } catch (error) {
            console.error('[People] update error:', error);
            res.status(500).json({ error: 'Error al actualizar la persona' });
        }
    });

    // ------------------------------------------------------------------
    // DELETE /api/people/:id — soft delete
    // ------------------------------------------------------------------
    app.delete('/api/people/:id', requireAuth, async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const ok = await personService.softDelete(tenantId, String(req.params.id), req.auth!.userId);
            if (!ok) {
                res.status(404).json({ error: 'Persona no encontrada' });
                return;
            }
            res.json({ success: true });
        } catch (error) {
            console.error('[People] delete error:', error);
            res.status(500).json({ error: 'Error al eliminar la persona' });
        }
    });

    // ------------------------------------------------------------------
    // POST /api/people/:id/photos — multi-photo upload (hasta 5)
    // Dispara el hook async de enrolamiento (T-24 implementa el processor).
    // ------------------------------------------------------------------
    app.post('/api/people/:id/photos', requireAuth, upload.array('photos', personService.MAX_PHOTOS_PER_PERSON), async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const personId = String(req.params.id);
            const person = await personService.getById(tenantId, personId);
            if (!person) {
                res.status(404).json({ error: 'Persona no encontrada' });
                return;
            }

            const files = (req.files as Express.Multer.File[] | undefined) ?? [];
            if (files.length === 0) {
                res.status(400).json({ error: 'Se requiere al menos un archivo de imagen' });
                return;
            }

            const created = [];
            for (const file of files) {
                const processed = await sharp(file.buffer)
                    .resize(800, 800, { fit: 'cover' })
                    .jpeg({ quality: 90 })
                    .toBuffer();
                const photo = await personService.addPhoto(tenantId, personId, processed, 'image/jpeg');
                created.push(photo);
            }

            res.status(201).json({ success: true, photos: created });
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'Error al procesar las fotos';
            console.error('[People] photo upload error:', error);
            res.status(400).json({ error: msg });
        }
    });

    // ------------------------------------------------------------------
    // GET /api/people/:id/photos/:photoId — sirve el binario
    // ------------------------------------------------------------------
    app.get('/api/people/:id/photos/:photoId', requireAuth, async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const photo = await personService.getPhotoData(tenantId, String(req.params.id), String(req.params.photoId));
            if (!photo) {
                res.status(404).json({ error: 'Foto no encontrada' });
                return;
            }
            res.setHeader('Content-Type', photo.mimeType);
            res.setHeader('Cache-Control', 'private, max-age=300');
            res.send(Buffer.from(photo.photoData));
        } catch (error) {
            console.error('[People] serve photo error:', error);
            res.status(500).json({ error: 'Error al obtener la foto' });
        }
    });

    // ------------------------------------------------------------------
    // DELETE /api/people/:id/photos/:photoId
    // ------------------------------------------------------------------
    app.delete('/api/people/:id/photos/:photoId', requireAuth, async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const ok = await personService.deletePhoto(tenantId, String(req.params.id), String(req.params.photoId));
            if (!ok) {
                res.status(404).json({ error: 'Foto no encontrada' });
                return;
            }
            res.json({ success: true });
        } catch (error) {
            console.error('[People] delete photo error:', error);
            res.status(500).json({ error: 'Error al eliminar la foto' });
        }
    });

    // ------------------------------------------------------------------
    // PUT /api/people/:id/photos/:photoId/primary
    // ------------------------------------------------------------------
    app.put('/api/people/:id/photos/:photoId/primary', requireAuth, async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const ok = await personService.setPrimaryPhoto(tenantId, String(req.params.id), String(req.params.photoId));
            if (!ok) {
                res.status(404).json({ error: 'Foto no encontrada' });
                return;
            }
            res.json({ success: true });
        } catch (error) {
            console.error('[People] primary photo error:', error);
            res.status(500).json({ error: 'Error al actualizar la foto primaria' });
        }
    });

    // ------------------------------------------------------------------
    // POST /api/people/:id/programs — vincular a programa(s) { programIds: [] }
    // DELETE /api/people/:id/programs/:programId — desvincular
    // ------------------------------------------------------------------
    app.post('/api/people/:id/programs', requireAuth, async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const { programIds } = req.body as { programIds?: string[] };
            if (!Array.isArray(programIds) || programIds.length === 0) {
                res.status(400).json({ error: 'Se requiere programIds (array)' });
                return;
            }
            const person = await personService.getById(tenantId, String(req.params.id));
            if (!person) {
                res.status(404).json({ error: 'Persona no encontrada' });
                return;
            }
            await personService.linkPrograms(tenantId, person.id, programIds);
            res.json({ success: true });
        } catch (error) {
            console.error('[People] link programs error:', error);
            res.status(500).json({ error: 'Error al vincular programas' });
        }
    });

    app.delete('/api/people/:id/programs/:programId', requireAuth, async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            await personService.unlinkProgram(tenantId, String(req.params.id), String(req.params.programId));
            res.json({ success: true });
        } catch (error) {
            console.error('[People] unlink program error:', error);
            res.status(500).json({ error: 'Error al desvincular el programa' });
        }
    });

    // ------------------------------------------------------------------
    // POST /api/people/:id/transmissions — invitado por fecha/transmisión
    // body: { transmissionId?, programId?, scheduledDate?, role? }
    // ------------------------------------------------------------------
    app.post('/api/people/:id/transmissions', requireAuth, async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const { transmissionId, programId, scheduledDate, role } = req.body as {
                transmissionId?: string; programId?: string; scheduledDate?: string; role?: string;
            };
            if (!transmissionId && !programId && !scheduledDate) {
                res.status(400).json({ error: 'Se requiere transmissionId, programId o scheduledDate' });
                return;
            }
            await personService.linkTransmission({
                tenantId,
                personId: String(req.params.id),
                transmissionId: transmissionId ?? null,
                programId: programId ?? null,
                scheduledDate: scheduledDate ?? null,
                role: role ?? 'guest',
            });
            res.json({ success: true });
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'Error al vincular transmisión';
            console.error('[People] link transmission error:', error);
            res.status(400).json({ error: msg });
        }
    });
}
