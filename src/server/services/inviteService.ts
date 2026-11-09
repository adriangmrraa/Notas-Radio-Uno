import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { UserRole, UserStatus, InvitationStatus } from '../db/schema/enums.js';
import { users, tenants, userTenants, teamInvitations, subscriptions, plans } from '../db/schema/index.js';
import { sendTeamInviteEmail } from './emailService.js';
import { audit } from './auditService.js';
import { eq, and, count } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// inviteService — invitaciones de equipo por email (T-38 / spec team-invites)
//
//   invite → email con token → accept (crea/une user + user_tenants con rol)
//   revoke / resend / unicidad pending / enforcement plans.maxTeamMembers
//   (miembros activos + invitaciones pending cuentan contra el límite).
// ---------------------------------------------------------------------------

const BCRYPT_ROUNDS = 12;
const INVITE_TTL_DAYS = 7;

function normalizeEmail(email: string): string {
    return email.toLowerCase().trim();
}

async function getTenantById(tenantId: string) {
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!t) throw new AppError('Tenant no encontrado', 404);
    return t;
}

/** Cuenta miembros activos + invitaciones pending (ambos pesan en el límite). */
async function teamUsage(tenantId: string): Promise<{ members: number; pending: number }> {
    const [m] = await db.select({ n: count() }).from(userTenants)
        .where(and(eq(userTenants.tenantId, tenantId), eq(userTenants.status, 'active')));
    const [p] = await db.select({ n: count() }).from(teamInvitations)
        .where(and(
            eq(teamInvitations.tenantId, tenantId),
            eq(teamInvitations.status, InvitationStatus.pending),
        ));
    return { members: m?.n ?? 0, pending: p?.n ?? 0 };
}

async function getMaxTeamMembers(tenantId: string): Promise<number> {
    const [row] = await db.select({ max: plans.maxTeamMembers })
        .from(subscriptions)
        .innerJoin(plans, eq(subscriptions.planId, plans.id))
        .where(eq(subscriptions.tenantId, tenantId))
        .limit(1);
    // Sin suscripción/plan → límite conservador 1 (solo owner).
    return row?.max ?? 1;
}

// ---------------------------------------------------------------------------
// Invite — crea invitación pending + envía email con token
// ---------------------------------------------------------------------------
export async function inviteMember(input: {
    tenantId: string;
    email: string;
    role: UserRole;
    invitedByUserId: string;
    inviterRole: UserRole;
    inviterName: string;
}) {
    const email = normalizeEmail(input.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new AppError('Email invalido', 400);
    }

    // Solo owner puede invitar owners (spec).
    if (input.role === UserRole.owner && input.inviterRole !== UserRole.owner) {
        throw new AppError('Solo el owner puede invitar a otro owner', 403, 'OWNER_REQUIRED');
    }

    const tenant = await getTenantById(input.tenantId);

    // ¿Ya es miembro del tenant? → 409
    const [existingUser] = await db.select({ id: users.id }).from(users)
        .where(eq(users.email, email)).limit(1);
    if (existingUser) {
        const [membership] = await db.select({ role: userTenants.role }).from(userTenants)
            .where(and(
                eq(userTenants.userId, existingUser.id),
                eq(userTenants.tenantId, input.tenantId),
                eq(userTenants.status, 'active'),
            )).limit(1);
        if (membership) {
            throw new AppError('Ese email ya es miembro del equipo', 409, 'ALREADY_MEMBER');
        }
    }

    // Unicidad pending: si hay invitación vigente → la renovamos (rotate token)
    // y reenviamos — nunca duplicamos tokens activos (spec edge).
    const [pending] = await db.select().from(teamInvitations)
        .where(and(
            eq(teamInvitations.tenantId, input.tenantId),
            eq(teamInvitations.email, email),
            eq(teamInvitations.status, InvitationStatus.pending),
        )).limit(1);

    // Enforcement maxTeamMembers (miembros + pending cuentan).
    const usage = await teamUsage(input.tenantId);
    const max = await getMaxTeamMembers(input.tenantId);
    if (!pending && usage.members + usage.pending >= max) {
        throw new AppError(
            `Limite de equipo alcanzado (${usage.members + usage.pending}/${max}). Subi de plan para sumar gente.`,
            403, 'LIMIT_TEAM_MEMBERS',
        );
    }

    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
    let token: string;

    if (pending) {
        // Reinvitación: rota token + renueva expiración (+rol si cambió).
        token = crypto.randomUUID();
        await db.update(teamInvitations)
            .set({ token, expiresAt, role: input.role, invitedById: input.invitedByUserId })
            .where(eq(teamInvitations.id, pending.id));
    } else {
        const [inv] = await db.insert(teamInvitations).values({
            tenantId: input.tenantId,
            invitedById: input.invitedByUserId,
            email,
            role: input.role,
            token: crypto.randomUUID(),
            status: InvitationStatus.pending,
            expiresAt,
        }).returning();
        token = inv.token;
    }

    sendTeamInviteEmail(email, input.inviterName, tenant.name, input.role, token).catch(console.error);

    void audit({
        tenantId: input.tenantId,
        actorUserId: input.invitedByUserId,
        action: 'team.invite',
        metadata: { email, role: input.role, resent: !!pending },
    });

    return { email, role: input.role, expiresAt, resent: !!pending };
}

// ---------------------------------------------------------------------------
// Accept — token → membresía (user existente o cuenta nueva)
// ---------------------------------------------------------------------------
export async function getInvitationByToken(token: string) {
    const [inv] = await db.select({
        id: teamInvitations.id,
        email: teamInvitations.email,
        role: teamInvitations.role,
        status: teamInvitations.status,
        expiresAt: teamInvitations.expiresAt,
        tenantName: tenants.name,
    })
        .from(teamInvitations)
        .innerJoin(tenants, eq(teamInvitations.tenantId, tenants.id))
        .where(eq(teamInvitations.token, token as any))
        .limit(1);
    if (!inv) throw new AppError('Invitacion invalida', 404, 'INVITE_INVALID');
    if (inv.status !== InvitationStatus.pending) {
        throw new AppError('Invitacion invalida', 410, 'INVITE_INVALID');
    }
    if (inv.expiresAt < new Date()) {
        await db.update(teamInvitations)
            .set({ status: InvitationStatus.expired })
            .where(eq(teamInvitations.id, inv.id));
        throw new AppError('La invitacion expiro. Pedi que te la reenvien.', 410, 'INVITE_EXPIRED');
    }
    return inv;
}

export async function acceptInvitation(input: {
    token: string;
    fullName?: string;
    password?: string;
    ip?: string;
    userAgent?: string;
}) {
    const inv = await getInvitationByToken(input.token);

    const [invRow] = await db.select().from(teamInvitations)
        .where(eq(teamInvitations.id, inv.id)).limit(1);
    if (!invRow) throw new AppError('Invitacion invalida', 404, 'INVITE_INVALID');

    const result = await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(users)
            .where(eq(users.email, inv.email)).limit(1);
        let user = existing;
        const isNewAccount = !user;

        if (user) {
            // Cuenta existente → solo se crea la membresía (spec multi-tenant).
            // Se verifica si no lo estaba: el link del mail valida el email.
            if (!user.isVerified) {
                await tx.update(users)
                    .set({ isVerified: true, status: UserStatus.active })
                    .where(eq(users.id, user.id));
            }
        } else {
            // Cuenta nueva → nombre + contraseña en la pantalla de aceptación.
            if (!input.fullName?.trim() || input.fullName.trim().length < 2) {
                throw new AppError('Nombre requerido (minimo 2 caracteres)', 400);
            }
            if (!input.password || input.password.length < 8) {
                throw new AppError('La contrasena debe tener al menos 8 caracteres', 400);
            }
            const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
            const [created] = await tx.insert(users).values({
                email: inv.email,
                passwordHash,
                fullName: input.fullName.trim(),
                role: inv.role,
                status: UserStatus.active,
                isVerified: true, // el token del email verifica la dirección
            }).returning();
            user = created;
        }
        if (!user) throw new AppError('No se pudo crear la cuenta', 500);

        // Membresía con el rol de la invitación (el invitado NUNCA elige rol).
        await tx.insert(userTenants).values({
            userId: user.id,
            tenantId: invRow.tenantId,
            role: inv.role,
            status: 'active',
            lastUsedAt: new Date(),
        }).onConflictDoNothing();

        await tx.update(teamInvitations)
            .set({ status: InvitationStatus.accepted, acceptedAt: new Date() })
            .where(eq(teamInvitations.id, inv.id));

        return { userId: user.id, tenantId: invRow.tenantId, isNewAccount };
    });

    void audit({
        tenantId: result.tenantId,
        actorUserId: result.userId,
        action: 'team.accept',
        ip: input.ip,
        userAgent: input.userAgent,
        metadata: { email: inv.email, role: inv.role },
    });

    return { message: 'Te uniste al equipo correctamente. Ya puedes iniciar sesion.', email: inv.email };
}

// ---------------------------------------------------------------------------
// Gestión: roster + revoke + resend + roles + remove (last-owner guard)
// ---------------------------------------------------------------------------
export async function listTeam(tenantId: string) {
    const members = await db.select({
        userId: userTenants.userId,
        role: userTenants.role,
        status: userTenants.status,
        lastUsedAt: userTenants.lastUsedAt,
        email: users.email,
        fullName: users.fullName,
        avatarUrl: users.avatarUrl,
        isPlatformAdmin: users.isPlatformAdmin,
    })
        .from(userTenants)
        .innerJoin(users, eq(userTenants.userId, users.id))
        .where(eq(userTenants.tenantId, tenantId));

    const pending = await db.select({
        id: teamInvitations.id,
        email: teamInvitations.email,
        role: teamInvitations.role,
        status: teamInvitations.status,
        expiresAt: teamInvitations.expiresAt,
        createdAt: teamInvitations.createdAt,
    })
        .from(teamInvitations)
        .where(and(
            eq(teamInvitations.tenantId, tenantId),
            eq(teamInvitations.status, InvitationStatus.pending),
        ));

    return { members, invitations: pending };
}

/** Emails de miembros activos del tenant por rol (billing/dunning notifications). */
export async function listMemberEmails(tenantId: string, roles: UserRole[] = [UserRole.owner]): Promise<string[]> {
    const rows = await db.select({ email: users.email, role: userTenants.role })
        .from(userTenants)
        .innerJoin(users, eq(userTenants.userId, users.id))
        .where(and(
            eq(userTenants.tenantId, tenantId),
            eq(userTenants.status, 'active'),
        ));
    return rows.filter((r) => roles.includes(r.role)).map((r) => r.email);
}

async function assertNotLastOwner(tenantId: string, targetUserId: string): Promise<void> {
    const owners = await db.select({ userId: userTenants.userId }).from(userTenants)
        .where(and(
            eq(userTenants.tenantId, tenantId),
            eq(userTenants.role, UserRole.owner),
            eq(userTenants.status, 'active'),
        ));
    if (owners.length === 1 && owners[0].userId === targetUserId) {
        throw new AppError('No puedes quitar al ultimo owner del tenant', 409, 'LAST_OWNER');
    }
}

export async function revokeInvitation(tenantId: string, invitationId: string, actorUserId: string) {
    const [inv] = await db.select().from(teamInvitations)
        .where(and(eq(teamInvitations.id, invitationId), eq(teamInvitations.tenantId, tenantId)))
        .limit(1);
    if (!inv || inv.status !== InvitationStatus.pending) {
        throw new AppError('Invitacion no encontrada', 404);
    }
    await db.update(teamInvitations)
        .set({ status: InvitationStatus.revoked })
        .where(eq(teamInvitations.id, invitationId));
    void audit({
        tenantId,
        actorUserId,
        action: 'team.revoke',
        metadata: { email: inv.email },
    });
    return { message: 'Invitacion revocada' };
}

export async function resendInvitation(tenantId: string, invitationId: string, actorUserId: string, inviterName: string) {
    const [row] = await db.select({
        id: teamInvitations.id,
        email: teamInvitations.email,
        role: teamInvitations.role,
        status: teamInvitations.status,
        tenantName: tenants.name,
    })
        .from(teamInvitations)
        .innerJoin(tenants, eq(teamInvitations.tenantId, tenants.id))
        .where(and(eq(teamInvitations.id, invitationId), eq(teamInvitations.tenantId, tenantId)))
        .limit(1);

    if (!row || row.status !== InvitationStatus.pending) {
        throw new AppError('Invitacion no encontrada', 404);
    }

    // Rotar token + renovar expiración (spec: "nuevo token/misma o renovada").
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
    await db.update(teamInvitations)
        .set({ token, expiresAt })
        .where(eq(teamInvitations.id, invitationId));

    sendTeamInviteEmail(row.email, inviterName, row.tenantName, row.role, token).catch(console.error);

    void audit({
        tenantId,
        actorUserId,
        action: 'team.resend',
        metadata: { email: row.email },
    });
    return { message: 'Invitacion reenviada', expiresAt };
}

export async function updateMemberRole(tenantId: string, targetUserId: string, role: UserRole, actorUserId: string) {
    const [membership] = await db.select().from(userTenants)
        .where(and(eq(userTenants.tenantId, tenantId), eq(userTenants.userId, targetUserId)))
        .limit(1);
    if (!membership) throw new AppError('Miembro no encontrado', 404);

    if (membership.role === UserRole.owner && role !== UserRole.owner) {
        await assertNotLastOwner(tenantId, targetUserId);
    }

    await db.update(userTenants)
        .set({ role })
        .where(and(eq(userTenants.tenantId, tenantId), eq(userTenants.userId, targetUserId)));

    void audit({
        tenantId,
        actorUserId,
        action: 'team.role_change',
        metadata: { targetUserId, from: membership.role, to: role },
    });
    return { message: 'Rol actualizado' };
}

export async function removeMember(tenantId: string, targetUserId: string, actorUserId: string) {
    const [membership] = await db.select().from(userTenants)
        .where(and(eq(userTenants.tenantId, tenantId), eq(userTenants.userId, targetUserId)))
        .limit(1);
    if (!membership) throw new AppError('Miembro no encontrado', 404);

    await assertNotLastOwner(tenantId, targetUserId);

    // Remoción = baja de la membresía. La revocación es efectiva en el próximo
    // request (requireAuth re-verifica user_tenants — D8).
    await db.delete(userTenants)
        .where(and(eq(userTenants.tenantId, tenantId), eq(userTenants.userId, targetUserId)));

    void audit({
        tenantId,
        actorUserId,
        action: 'team.remove',
        metadata: { targetUserId, removedRole: membership.role },
    });
    return { message: 'Miembro removido del equipo' };
}
