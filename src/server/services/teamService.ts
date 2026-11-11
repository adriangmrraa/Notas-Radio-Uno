/**
 * teamService.ts — Equipo del tenant: miembros, invitaciones y roles
 *
 * Reglas de negocio:
 *  - Sólo se invitan roles `editor` o `viewer`. El rol `owner` no se invita:
 *    se transfiere desde el módulo de equipo (o queda el owner original).
 *  - Un invite nace `pending` con token UUID y vence a las 72 h.
 *  - Aceptar el invite crea la MEMBRESÍA en el tenant invitante: si el mail ya
 *    tiene cuenta (en este o en otro tenant) se reutiliza, no se duplica.
 *    La posesión del token (que llegó por mail) prueba el mail.
 *  - `users.email` es único global (una identidad por persona, B-2), pero una
 *    persona puede tener membresías en varios tenants con roles distintos.
 *  - Cupo: `plans.max_team_members` cuenta COLABORADORES además del owner
 *    (default 1 → el owner puede sumar 1 persona). 0 = sin equipo.
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  plans,
  refreshTokens,
  subscriptions,
  teamInvitations,
  tenants,
  userTenants,
  users,
} from '../db/schema/index.js';
import { UserRole, UserStatus } from '../db/schema/enums.js';
import type { UserRole as UserRoleType } from '../db/schema/enums.js';
import { AppError } from '../lib/errors.js';
import { recordAuditEvent, AUDIT_ACTIONS } from './auditService.js';
import { countActiveOwners, ensureMembership } from './membershipService.js';
import { sendTeamInviteEmail } from './emailService.js';

const BCRYPT_ROUNDS = 12;
export const INVITE_TTL_HOURS = 72;
const INVITABLE_ROLES: UserRoleType[] = [UserRole.editor, UserRole.viewer];

// ── Helpers ───────────────────────────────────────────────────────────────────

function inviteExpiry(): Date {
  return new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);
}

async function getCollaboratorSeatLimit(tenantId: string): Promise<number> {
  const rows = await db
    .select({ maxTeamMembers: plans.maxTeamMembers })
    .from(subscriptions)
    .innerJoin(plans, eq(subscriptions.planId, plans.id))
    .where(eq(subscriptions.tenantId, tenantId))
    .limit(1);

  const limit = rows[0]?.maxTeamMembers;
  // Sin plan registrado se asume el default comercial (1 colaborador).
  return typeof limit === 'number' ? limit : 1;
}

async function countUsedSeats(tenantId: string): Promise<number> {
  // Los asientos se cuentan sobre MEMBRESÍAS, no sobre usuarios: con B-2 una
  // persona puede estar en varios tenants y el cupo es por tenant.
  const [members] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(userTenants)
    .where(and(
      eq(userTenants.tenantId, tenantId),
      ne(userTenants.role, UserRole.owner),
      ne(userTenants.status, 'suspended'),
    ));

  const [pending] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(teamInvitations)
    .where(and(eq(teamInvitations.tenantId, tenantId), eq(teamInvitations.status, 'pending')));

  return (members?.total ?? 0) + (pending?.total ?? 0);
}

/** Marca como expirados los invites vencidos del tenant (barrido barato). */
async function expireStaleInvites(tenantId: string): Promise<void> {
  await db
    .update(teamInvitations)
    .set({ status: 'expired' })
    .where(
      and(
        eq(teamInvitations.tenantId, tenantId),
        eq(teamInvitations.status, 'pending'),
        sql`${teamInvitations.expiresAt} < now()`,
      ),
    );
}

async function getInviterName(userId: string): Promise<string> {
  const [row] = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.fullName ?? 'El equipo';
}

async function getTenantName(tenantId: string): Promise<string> {
  const [row] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return row?.name ?? 'PeriodistApp';
}

async function sendInviteEmail(invite: {
  email: string;
  role: UserRoleType;
  token: string;
  tenantId: string;
  invitedById: string;
}): Promise<void> {
  const [tenantName, inviterName] = await Promise.all([
    getTenantName(invite.tenantId),
    getInviterName(invite.invitedById),
  ]);
  await sendTeamInviteEmail(invite.email, {
    tenantName,
    inviterName,
    role: invite.role,
    token: invite.token,
    expiresInHours: INVITE_TTL_HOURS,
    tenantId: invite.tenantId,
  });
}

// ── Lectura ───────────────────────────────────────────────────────────────────

export interface TeamMemberView {
  id: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  role: UserRoleType;
  status: string;
  isVerified: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface TeamInviteView {
  id: string;
  email: string;
  role: UserRoleType;
  status: string;
  expiresAt: Date;
  lastSentAt: Date;
  createdAt: Date;
  invitedByName: string | null;
  isExpired: boolean;
}

export async function listTeam(tenantId: string): Promise<{
  members: TeamMemberView[];
  invites: TeamInviteView[];
  seats: { used: number; limit: number };
}> {
  await expireStaleInvites(tenantId);

  const members = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      avatarUrl: users.avatarUrl,
      role: userTenants.role,
      status: userTenants.status,
      isVerified: users.isVerified,
      lastLoginAt: users.lastLoginAt,
      createdAt: userTenants.createdAt,
    })
    .from(userTenants)
    .innerJoin(users, eq(userTenants.userId, users.id))
    .where(eq(userTenants.tenantId, tenantId))
    .orderBy(asc(userTenants.createdAt));

  const inviteRows = await db
    .select({
      id: teamInvitations.id,
      email: teamInvitations.email,
      role: teamInvitations.role,
      status: teamInvitations.status,
      expiresAt: teamInvitations.expiresAt,
      lastSentAt: teamInvitations.lastSentAt,
      createdAt: teamInvitations.createdAt,
      invitedByName: users.fullName,
    })
    .from(teamInvitations)
    .leftJoin(users, eq(teamInvitations.invitedById, users.id))
    .where(
      and(
        eq(teamInvitations.tenantId, tenantId),
        inArray(teamInvitations.status, ['pending', 'expired', 'revoked']),
      ),
    )
    .orderBy(desc(teamInvitations.createdAt))
    .limit(50);

  const now = Date.now();
  return {
    members,
    invites: inviteRows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      status: r.status,
      expiresAt: r.expiresAt,
      lastSentAt: r.lastSentAt,
      createdAt: r.createdAt,
      invitedByName: r.invitedByName ?? null,
      isExpired: r.status === 'expired' || r.expiresAt.getTime() < now,
    })),
    seats: { used: await countUsedSeats(tenantId), limit: await getCollaboratorSeatLimit(tenantId) },
  };
}

/** Preview público de un invite (para la pantalla de aceptación). */
export async function getInvitePreview(token: string) {
  const [row] = await db
    .select({
      id: teamInvitations.id,
      email: teamInvitations.email,
      role: teamInvitations.role,
      status: teamInvitations.status,
      expiresAt: teamInvitations.expiresAt,
      tenantName: tenants.name,
      tenantSlug: tenants.slug,
      invitedByName: users.fullName,
    })
    .from(teamInvitations)
    .leftJoin(tenants, eq(teamInvitations.tenantId, tenants.id))
    .leftJoin(users, eq(teamInvitations.invitedById, users.id))
    .where(eq(teamInvitations.token, token))
    .limit(1);

  if (!row) throw new AppError('Invitación no encontrada', 404, 'INVITE_NOT_FOUND');

  const expired = row.status === 'expired' || row.expiresAt.getTime() < Date.now();
  if (row.status === 'accepted') throw new AppError('Esta invitación ya fue utilizada', 410, 'INVITE_ACCEPTED');
  if (row.status === 'revoked') throw new AppError('Esta invitación fue revocada', 410, 'INVITE_REVOKED');
  if (expired) throw new AppError('Esta invitación expiró', 410, 'INVITE_EXPIRED');

  return {
    email: row.email,
    role: row.role,
    tenantName: row.tenantName ?? 'PeriodistApp',
    tenantSlug: row.tenantSlug ?? null,
    invitedByName: row.invitedByName ?? null,
    expiresAt: row.expiresAt,
  };
}

// ── Invitaciones ──────────────────────────────────────────────────────────────

export async function inviteMember(input: {
  tenantId: string;
  actorUserId: string;
  email: string;
  role: string;
}): Promise<{ invite: TeamInviteView; resent: boolean }> {
  const email = input.email.toLowerCase().trim();
  const role = input.role as UserRoleType;

  if (!INVITABLE_ROLES.includes(role)) {
    throw new AppError('Sólo se pueden invitar roles editor o viewer', 400, 'INVALID_ROLE');
  }

  // Con B-2 un mail YA puede tener cuenta en otra organización: lo que no puede
  // es estar dos veces en el mismo tenant.
  const [existingUser] = await db.select({ id: users.id }).from(users)
    .where(eq(users.email, email)).limit(1);

  if (existingUser) {
    const [membership] = await db.select({ status: userTenants.status })
      .from(userTenants)
      .where(and(
        eq(userTenants.userId, existingUser.id),
        eq(userTenants.tenantId, input.tenantId),
      ))
      .limit(1);
    if (membership) {
      throw new AppError('Ese email ya es parte de tu equipo', 409, 'ALREADY_MEMBER');
    }
  }

  const used = await countUsedSeats(input.tenantId);
  const limit = await getCollaboratorSeatLimit(input.tenantId);
  if (used >= limit) {
    throw new AppError(
      `Tu plan incluye ${limit} colaborador(es) y ya los estás usando. Mejorá el plan para sumar más gente.`,
      402,
      'SEAT_LIMIT',
    );
  }

  const [pending] = await db.select().from(teamInvitations).where(
    and(
      eq(teamInvitations.tenantId, input.tenantId),
      eq(teamInvitations.email, email),
      eq(teamInvitations.status, 'pending'),
    ),
  ).limit(1);

  let row;
  let resent = false;

  if (pending) {
    // Reinvitar = rotar token y extender vencimiento (no se crean duplicados).
    [row] = await db.update(teamInvitations).set({
      role,
      token: crypto.randomUUID(),
      expiresAt: inviteExpiry(),
      lastSentAt: new Date(),
      invitedById: input.actorUserId,
    }).where(eq(teamInvitations.id, pending.id)).returning();
    resent = true;
  } else {
    [row] = await db.insert(teamInvitations).values({
      tenantId: input.tenantId,
      invitedById: input.actorUserId,
      email,
      role,
      token: crypto.randomUUID(),
      status: 'pending',
      expiresAt: inviteExpiry(),
      lastSentAt: new Date(),
    }).returning();
  }

  await sendInviteEmail({
    email: row.email,
    role: row.role,
    token: row.token,
    tenantId: row.tenantId,
    invitedById: row.invitedById,
  });

  await recordAuditEvent({
    action: resent ? AUDIT_ACTIONS.INVITE_RESENT : AUDIT_ACTIONS.INVITE_CREATED,
    tenantId: input.tenantId,
    userId: input.actorUserId,
    actorRole: UserRole.owner,
    entityType: 'team_invite',
    entityId: row.id,
    metadata: { email, role },
  });

  return {
    invite: {
      id: row.id,
      email: row.email,
      role: row.role,
      status: row.status,
      expiresAt: row.expiresAt,
      lastSentAt: row.lastSentAt,
      createdAt: row.createdAt,
      invitedByName: null,
      isExpired: false,
    },
    resent,
  };
}

export async function resendInvite(input: {
  tenantId: string;
  inviteId: string;
  actorUserId: string;
}): Promise<void> {
  const [invite] = await db.select().from(teamInvitations).where(
    and(eq(teamInvitations.tenantId, input.tenantId), eq(teamInvitations.id, input.inviteId)),
  ).limit(1);

  if (!invite) throw new AppError('Invitación no encontrada', 404, 'INVITE_NOT_FOUND');
  if (invite.status === 'accepted') throw new AppError('La invitación ya fue aceptada', 409, 'INVITE_ACCEPTED');
  if (invite.status === 'revoked') throw new AppError('La invitación fue revocada: creá una nueva', 409, 'INVITE_REVOKED');

  const [row] = await db.update(teamInvitations).set({
    token: crypto.randomUUID(),
    status: 'pending',
    expiresAt: inviteExpiry(),
    lastSentAt: new Date(),
    invitedById: input.actorUserId,
  }).where(eq(teamInvitations.id, invite.id)).returning();

  await sendInviteEmail({
    email: row.email,
    role: row.role,
    token: row.token,
    tenantId: row.tenantId,
    invitedById: row.invitedById,
  });

  await recordAuditEvent({
    action: AUDIT_ACTIONS.INVITE_RESENT,
    tenantId: input.tenantId,
    userId: input.actorUserId,
    entityType: 'team_invite',
    entityId: invite.id,
    metadata: { email: invite.email },
  });
}

export async function revokeInvite(input: {
  tenantId: string;
  inviteId: string;
  actorUserId: string;
}): Promise<void> {
  const [invite] = await db.select().from(teamInvitations).where(
    and(eq(teamInvitations.tenantId, input.tenantId), eq(teamInvitations.id, input.inviteId)),
  ).limit(1);

  if (!invite) throw new AppError('Invitación no encontrada', 404, 'INVITE_NOT_FOUND');
  if (invite.status === 'accepted') throw new AppError('La invitación ya fue aceptada', 409, 'INVITE_ACCEPTED');

  await db.update(teamInvitations).set({
    status: 'revoked',
    revokedAt: new Date(),
    revokedByUserId: input.actorUserId,
  }).where(eq(teamInvitations.id, invite.id));

  await recordAuditEvent({
    action: AUDIT_ACTIONS.INVITE_REVOKED,
    tenantId: input.tenantId,
    userId: input.actorUserId,
    entityType: 'team_invite',
    entityId: invite.id,
    metadata: { email: invite.email },
  });
}

/**
 * Acepta la invitación: crea o reutiliza el usuario y le crea la MEMBRESÍA en el
 * tenant del invite (B-2: si el mail ya tiene cuenta en otra organización, no se
 * duplica el usuario ni se mueve de tenant — sólo se suma la membresía).
 * Público (no requiere sesión) — la prueba de identidad es el token del mail.
 */
export async function acceptInvite(input: {
  token: string;
  fullName: string;
  password: string;
}): Promise<{ message: string; email: string; tenantSlug: string | null }> {
  const [invite] = await db.select().from(teamInvitations)
    .where(eq(teamInvitations.token, input.token)).limit(1);

  if (!invite) throw new AppError('Invitación no encontrada', 404, 'INVITE_NOT_FOUND');
  if (invite.status === 'accepted') throw new AppError('Esta invitación ya fue utilizada', 410, 'INVITE_ACCEPTED');
  if (invite.status === 'revoked') throw new AppError('Esta invitación fue revocada', 410, 'INVITE_REVOKED');
  if (invite.status === 'expired' || invite.expiresAt.getTime() < Date.now()) {
    throw new AppError('Esta invitación expiró. Pedí un reenvío.', 410, 'INVITE_EXPIRED');
  }

  const [existingUser] = await db.select({ id: users.id }).from(users)
    .where(eq(users.email, invite.email)).limit(1);

  const [tenantRow] = await db.select({ slug: tenants.slug, name: tenants.name })
    .from(tenants).where(eq(tenants.id, invite.tenantId)).limit(1);
  if (!tenantRow) throw new AppError('La organización ya no existe', 410, 'TENANT_GONE');

  let userId: string;

  if (existingUser) {
    // Cuenta existente: la membresía es lo único que cambia. La cuenta y el
    // acceso a sus otras organizaciones quedan intactos.
    userId = existingUser.id;
    await db.update(users).set({
      fullName: input.fullName,
      status: UserStatus.active,
      isVerified: true,
    }).where(eq(users.id, userId));
  } else {
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const [created] = await db.insert(users).values({
      email: invite.email,
      passwordHash,
      fullName: input.fullName,
      // Legacy: primer tenant del usuario.
      tenantId: invite.tenantId,
      role: invite.role,
      status: UserStatus.active,
      isVerified: true, // la posesión del token prueba el mail
    }).returning({ id: users.id });
    userId = created.id;
  }

  // Membresía en el tenant invitante con el rol del invite (reactiva si existía).
  await ensureMembership({ userId, tenantId: invite.tenantId, role: invite.role });

  await db.update(teamInvitations).set({
    status: 'accepted',
    acceptedAt: new Date(),
    acceptedByUserId: userId,
  }).where(eq(teamInvitations.id, invite.id));

  await recordAuditEvent({
    action: AUDIT_ACTIONS.INVITE_ACCEPTED,
    tenantId: invite.tenantId,
    userId,
    actorEmail: invite.email,
    actorRole: invite.role,
    entityType: 'team_invite',
    entityId: invite.id,
    metadata: { role: invite.role },
  });

  return {
    message: `Ya sos parte de ${tenantRow.name}. Iniciá sesión con ${invite.email}.`,
    email: invite.email,
    tenantSlug: tenantRow.slug,
  };
}

// ── Miembros ──────────────────────────────────────────────────────────────────

export async function changeMemberRole(input: {
  tenantId: string;
  memberId: string;
  role: string;
  actorUserId: string;
}): Promise<void> {
  const role = input.role as UserRoleType;
  if (![UserRole.owner, UserRole.editor, UserRole.viewer].includes(role)) {
    throw new AppError('Rol inválido', 400, 'INVALID_ROLE');
  }

  const [member] = await db
    .select({ userId: userTenants.userId, role: userTenants.role })
    .from(userTenants)
    .where(and(eq(userTenants.tenantId, input.tenantId), eq(userTenants.userId, input.memberId)))
    .limit(1);

  if (!member) throw new AppError('Miembro no encontrado', 404, 'MEMBER_NOT_FOUND');

  // No dejar el tenant sin owner.
  if (member.role === UserRole.owner && role !== UserRole.owner) {
    if ((await countActiveOwners(input.tenantId)) <= 1) {
      throw new AppError('No podés quitar el último owner de la organización', 409, 'LAST_OWNER');
    }
  }

  await db.update(userTenants)
    .set({ role, updatedAt: new Date() })
    .where(and(eq(userTenants.tenantId, input.tenantId), eq(userTenants.userId, member.userId)));

  await recordAuditEvent({
    action: AUDIT_ACTIONS.MEMBER_ROLE_CHANGED,
    tenantId: input.tenantId,
    userId: input.actorUserId,
    entityType: 'user',
    entityId: member.userId,
    metadata: { from: member.role, to: role },
  });
}

/**
 * Quita a un colaborador: suspende SU MEMBRESÍA (no la cuenta, que puede seguir
 * operando en otras organizaciones) y revoca sus refresh tokens en ese tenant.
 */
export async function removeMember(input: {
  tenantId: string;
  memberId: string;
  actorUserId: string;
}): Promise<void> {
  const [member] = await db
    .select({ userId: userTenants.userId, role: userTenants.role })
    .from(userTenants)
    .where(and(eq(userTenants.tenantId, input.tenantId), eq(userTenants.userId, input.memberId)))
    .limit(1);

  if (!member) throw new AppError('Miembro no encontrado', 404, 'MEMBER_NOT_FOUND');
  if (member.role === UserRole.owner) {
    throw new AppError('No se puede quitar al owner. Transferí la titularidad primero.', 409, 'CANNOT_REMOVE_OWNER');
  }

  await db.update(userTenants)
    .set({ status: 'suspended', updatedAt: new Date() })
    .where(and(eq(userTenants.tenantId, input.tenantId), eq(userTenants.userId, member.userId)));

  await db.update(refreshTokens)
    .set({ isRevoked: true })
    .where(and(eq(refreshTokens.userId, member.userId), eq(refreshTokens.tenantId, input.tenantId)));

  const [memberUser] = await db.select({ email: users.email }).from(users)
    .where(eq(users.id, member.userId)).limit(1);

  await recordAuditEvent({
    action: AUDIT_ACTIONS.MEMBER_REMOVED,
    tenantId: input.tenantId,
    userId: input.actorUserId,
    entityType: 'user',
    entityId: member.userId,
    metadata: { email: memberUser?.email ?? null },
  });
}
