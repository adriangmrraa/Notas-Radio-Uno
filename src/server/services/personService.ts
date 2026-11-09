import { db } from '../db/index.js';
import {
    persons,
    personPhotos,
    personProgram,
    personTransmission,
    programs,
} from '../db/schema/index.js';
import type { PersonRole } from '../db/schema/people.js';
import { eq, and, asc, inArray } from 'drizzle-orm';
import { audit } from './auditService.js';

// ---------------------------------------------------------------------------
// personService — biblioteca unificada de personas (T-27, spec people-directory)
//
//   - CRUD tenant-scoped + soft delete (is_active)
//   - Fotos bytea + enrollment_status por foto (pending → enrolled/no_face/…)
//   - Vínculos: person_program (M2M) y person_transmission (invitado por fecha)
//   - Hook de enrolamiento ASYNC: setEnrollmentProcessor() — T-24 registra el
//     worker real; acá solo se dispara el hook tras insertar fotos.
// ---------------------------------------------------------------------------

export const MAX_PHOTOS_PER_PERSON = 5;

export type Person = typeof persons.$inferSelect;

// ── Enrollment hook (T-24 registra el procesador real) ────────────────────────
export type EnrollmentProcessor = (input: {
    tenantId: string;
    personId: string;
    photoIds: string[];
}) => Promise<void> | void;

let enrollmentProcessor: EnrollmentProcessor | null = null;
export function setEnrollmentProcessor(fn: EnrollmentProcessor | null): void {
    enrollmentProcessor = fn;
}

function triggerEnrollment(tenantId: string, personId: string, photoIds: string[]): void {
    if (!enrollmentProcessor || photoIds.length === 0) return;
    try {
        void Promise.resolve(enrollmentProcessor({ tenantId, personId, photoIds }))
            .catch((e) => console.warn(`[People] enrollment processor error person=${personId}:`, e));
    } catch (e) {
        console.warn('[People] enrollment processor threw:', e);
    }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
export interface PersonInput {
    name: string;
    role?: PersonRole | null;
    bio?: string | null;
    socials?: Record<string, unknown>;
    notes?: string | null;
    /** ISO string o true (= ahora). */
    consentAt?: string | boolean | null;
    programIds?: string[];
}

function parseConsent(v: string | boolean | null | undefined): Date | null {
    if (v === true) return new Date();
    if (typeof v === 'string' && v.trim()) {
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
}

export async function create(tenantId: string, input: PersonInput, actorUserId?: string | null): Promise<Person> {
    const [person] = await db.insert(persons).values({
        tenantId,
        name: input.name.trim(),
        role: input.role ?? null,
        bio: input.bio ?? null,
        socials: input.socials ?? {},
        notes: input.notes ?? null,
        consentAt: parseConsent(input.consentAt),
    }).returning();

    if (input.programIds?.length) {
        await linkPrograms(tenantId, person.id, input.programIds);
    }

    void audit({ actorUserId: actorUserId ?? null, tenantId, action: 'person.created', metadata: { personId: person.id, name: person.name } });
    return person;
}

export async function update(
    tenantId: string,
    id: string,
    patch: Partial<PersonInput> & { isActive?: boolean },
    actorUserId?: string | null,
): Promise<Person | null> {
    const data: Partial<typeof persons.$inferInsert> = {};
    if (patch.name !== undefined) data.name = patch.name.trim();
    if (patch.role !== undefined) data.role = patch.role;
    if (patch.bio !== undefined) data.bio = patch.bio;
    if (patch.socials !== undefined) data.socials = patch.socials;
    if (patch.notes !== undefined) data.notes = patch.notes;
    if (patch.consentAt !== undefined) data.consentAt = parseConsent(patch.consentAt);
    if (patch.isActive !== undefined) data.isActive = patch.isActive;

    const [updated] = await db.update(persons)
        .set(data)
        .where(and(eq(persons.id, id), eq(persons.tenantId, tenantId)))
        .returning();
    if (!updated) return null;

    if (patch.programIds) {
        await db.delete(personProgram).where(eq(personProgram.personId, id));
        if (patch.programIds.length) await linkPrograms(tenantId, id, patch.programIds);
    }

    void audit({ actorUserId: actorUserId ?? null, tenantId, action: 'person.updated', metadata: { personId: id, fields: Object.keys(data) } });
    return updated;
}

export async function softDelete(tenantId: string, id: string, actorUserId?: string | null): Promise<boolean> {
    const [row] = await db.update(persons)
        .set({ isActive: false })
        .where(and(eq(persons.id, id), eq(persons.tenantId, tenantId), eq(persons.isActive, true)))
        .returning({ id: persons.id });
    if (!row) return false;
    void audit({ actorUserId: actorUserId ?? null, tenantId, action: 'person.deleted', metadata: { personId: id } });
    return true;
}

export async function getById(tenantId: string, id: string): Promise<Person | null> {
    const [person] = await db.select().from(persons)
        .where(and(eq(persons.id, id), eq(persons.tenantId, tenantId)))
        .limit(1);
    return person ?? null;
}

export interface ListPersonsFilter {
    programId?: string;
    includeInactive?: boolean;
    role?: PersonRole;
}

/** Lista de personas del tenant, opcionalmente filtrada por programa (M2M). */
export async function list(tenantId: string, filter: ListPersonsFilter = {}): Promise<Person[]> {
    const conditions = [eq(persons.tenantId, tenantId)];
    if (!filter.includeInactive) conditions.push(eq(persons.isActive, true));
    if (filter.role) conditions.push(eq(persons.role, filter.role));

    if (filter.programId) {
        const links = await db.select({ personId: personProgram.personId })
            .from(personProgram)
            .where(eq(personProgram.programId, filter.programId));
        const ids = links.map((l) => l.personId);
        if (ids.length === 0) return [];
        conditions.push(inArray(persons.id, ids));
    }

    return db.select().from(persons)
        .where(and(...conditions))
        .orderBy(asc(persons.name));
}

/** Devuelve los programIds vinculados para un set de personas (1 query). */
export async function listProgramLinks(personIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (personIds.length === 0) return map;
    const rows = await db.select().from(personProgram)
        .where(inArray(personProgram.personId, personIds));
    for (const r of rows) {
        const arr = map.get(r.personId) ?? [];
        arr.push(r.programId);
        map.set(r.personId, arr);
    }
    return map;
}

// ---------------------------------------------------------------------------
// Photos — bytea + enrollment hook
// ---------------------------------------------------------------------------
export async function listPhotos(personId: string) {
    return db.select({
        id: personPhotos.id,
        personId: personPhotos.personId,
        mimeType: personPhotos.mimeType,
        isPrimary: personPhotos.isPrimary,
        enrollmentStatus: personPhotos.enrollmentStatus,
        rejectionReason: personPhotos.rejectionReason,
        createdAt: personPhotos.createdAt,
    }).from(personPhotos).where(eq(personPhotos.personId, personId));
}

export async function addPhoto(
    tenantId: string,
    personId: string,
    data: Buffer,
    mimeType: string,
): Promise<{ id: string; enrollmentStatus: string }> {
    const existing = await db.select({ id: personPhotos.id })
        .from(personPhotos).where(eq(personPhotos.personId, personId));
    if (existing.length >= MAX_PHOTOS_PER_PERSON) {
        throw new Error(`La persona ya tiene el máximo de ${MAX_PHOTOS_PER_PERSON} fotos`);
    }

    const [photo] = await db.insert(personPhotos).values({
        personId,
        photoData: data,
        mimeType,
        isPrimary: existing.length === 0,
        enrollmentStatus: 'pending',
    }).returning({ id: personPhotos.id, enrollmentStatus: personPhotos.enrollmentStatus });

    // Estado de la persona: tiene fotos pendientes de enrolar → 'partial'.
    await refreshEnrollmentStatus(personId);

    // Hook async — T-24 enchufa el processor real (face detection/embedding).
    triggerEnrollment(tenantId, personId, [photo.id]);
    return photo;
}

export async function getPhotoData(tenantId: string, personId: string, photoId: string) {
    // Tenant check via person ownership (photo cuelga de person tenant-scoped)
    const person = await getById(tenantId, personId);
    if (!person) return null;
    const [photo] = await db.select().from(personPhotos)
        .where(and(eq(personPhotos.id, photoId), eq(personPhotos.personId, personId)))
        .limit(1);
    return photo ?? null;
}

export async function deletePhoto(tenantId: string, personId: string, photoId: string): Promise<boolean> {
    const person = await getById(tenantId, personId);
    if (!person) return false;

    const [photo] = await db.select({ id: personPhotos.id, isPrimary: personPhotos.isPrimary })
        .from(personPhotos)
        .where(and(eq(personPhotos.id, photoId), eq(personPhotos.personId, personId)))
        .limit(1);
    if (!photo) return false;

    await db.transaction(async (tx) => {
        await tx.delete(personPhotos).where(eq(personPhotos.id, photoId));
        if (photo.isPrimary) {
            const [next] = await tx.select({ id: personPhotos.id })
                .from(personPhotos)
                .where(eq(personPhotos.personId, personId))
                .orderBy(personPhotos.createdAt)
                .limit(1);
            if (next) {
                await tx.update(personPhotos).set({ isPrimary: true }).where(eq(personPhotos.id, next.id));
            }
        }
    });

    await refreshEnrollmentStatus(personId);
    return true;
}

export async function setPrimaryPhoto(tenantId: string, personId: string, photoId: string): Promise<boolean> {
    const person = await getById(tenantId, personId);
    if (!person) return false;
    const [photo] = await db.select({ id: personPhotos.id })
        .from(personPhotos)
        .where(and(eq(personPhotos.id, photoId), eq(personPhotos.personId, personId)))
        .limit(1);
    if (!photo) return false;

    await db.transaction(async (tx) => {
        await tx.update(personPhotos).set({ isPrimary: false }).where(eq(personPhotos.personId, personId));
        await tx.update(personPhotos).set({ isPrimary: true }).where(eq(personPhotos.id, photoId));
    });
    return true;
}

/**
 * Recomputa persons.enrollment_status según el estado de sus fotos.
 * Llamado por add/deletePhoto y por el processor de T-24 al marcar estados.
 */
export async function refreshEnrollmentStatus(personId: string): Promise<void> {
    const photos = await db.select({ status: personPhotos.enrollmentStatus })
        .from(personPhotos).where(eq(personPhotos.personId, personId));

    let status: 'none' | 'partial' | 'ready' = 'none';
    if (photos.length > 0) {
        const enrolled = photos.filter((p) => p.status === 'enrolled').length;
        status = enrolled === photos.length ? 'ready' : 'partial';
    }
    await db.update(persons).set({ enrollmentStatus: status }).where(eq(persons.id, personId));
}

// ---------------------------------------------------------------------------
// Links — person_program (M2M) y person_transmission (invitado por fecha)
// ---------------------------------------------------------------------------
async function assertProgramsBelongToTenant(tenantId: string, programIds: string[]): Promise<string[]> {
    if (programIds.length === 0) return [];
    const rows = await db.select({ id: programs.id })
        .from(programs)
        .where(and(eq(programs.tenantId, tenantId), inArray(programs.id, programIds)));
    return rows.map((r) => r.id);
}

export async function linkPrograms(tenantId: string, personId: string, programIds: string[]): Promise<void> {
    const valid = await assertProgramsBelongToTenant(tenantId, programIds);
    for (const programId of valid) {
        await db.insert(personProgram)
            .values({ personId, programId })
            .onConflictDoNothing();
    }
}

export async function unlinkProgram(tenantId: string, personId: string, programId: string): Promise<void> {
    const person = await getById(tenantId, personId);
    if (!person) return;
    await db.delete(personProgram)
        .where(and(eq(personProgram.personId, personId), eq(personProgram.programId, programId)));
}

export async function linkTransmission(input: {
    tenantId: string;
    personId: string;
    transmissionId?: string | null;
    programId?: string | null;
    scheduledDate?: string | null;
    role?: string;
}): Promise<void> {
    const person = await getById(input.tenantId, input.personId);
    if (!person) throw new Error('Persona no encontrada');

    await db.insert(personTransmission).values({
        tenantId: input.tenantId,
        personId: input.personId,
        transmissionId: input.transmissionId ?? null,
        programId: input.programId ?? null,
        scheduledDate: input.scheduledDate ?? null,
        role: input.role ?? 'guest',
    }).onConflictDoNothing();
}

/** Personas esperadas para una transmisión/fecha+programa (contexto del pipeline). */
export async function listForTransmission(tenantId: string, transmissionId: string): Promise<Person[]> {
    const links = await db.select({ personId: personTransmission.personId })
        .from(personTransmission)
        .where(and(
            eq(personTransmission.tenantId, tenantId),
            eq(personTransmission.transmissionId, transmissionId),
        ));
    const ids = links.map((l) => l.personId);
    if (ids.length === 0) return [];
    return db.select().from(persons)
        .where(and(inArray(persons.id, ids), eq(persons.tenantId, tenantId), eq(persons.isActive, true)));
}
