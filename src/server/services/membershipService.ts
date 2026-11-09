/**
 * membershipService.ts — membresías N:M usuario ↔ tenant (decisión B-2)
 *
 * Fuente de verdad del acceso: `user_tenants`. Nada que dependa del tenant debe
 * leer `users.tenantId` (legacy, primer tenant) ni `users.role` (rol histórico):
 * el rol efectivo es el de la membresía del tenant ACTIVO de la sesión.
 *
 * Reglas:
 *  - Una membresía `suspended` corta el acceso a ese tenant en el próximo
 *    request, sin suspender la cuenta (que puede seguir en otros tenants).
 *  - Un tenant con `isActive = false` (suspendido por plataforma) no es
 *    operable aunque la membresía esté activa.
 *  - Un usuario con 0 membresías no ve datos: la app muestra "sin acceso".
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, userTenants } from '../db/schema/index.js';
import type { UserRole } from '../db/schema/enums.js';
import { AppError } from '../lib/errors.js';

export type MembershipStatus = 'active' | 'suspended';

/** Tenant + rol de la membresía, tal como lo consume la UI (switcher). */
export interface MembershipView {
  tenantId: string;
  name: string;
  slug: string;
  platformName: string | null;
  logoUrl: string | null;
  role: UserRole;
  status: string;
  lastUsedAt: Date | null;
  isActive: boolean;
}

export interface ActiveMembership {
  tenantId: string;
  role: UserRole;
  status: string;
  tenant: {
    id: string;
    name: string;
    slug: string;
    platformName: string | null;
    logoUrl: string | null;
    timezone: string;
    isActive: boolean;
  };
}

/** Todas las membresías del usuario, la última usada primero. */
export async function listUserMemberships(userId: string): Promise<MembershipView[]> {
  const rows = await db
    .select({
      tenantId: userTenants.tenantId,
      role: userTenants.role,
      status: userTenants.status,
      lastUsedAt: userTenants.lastUsedAt,
      name: tenants.name,
      slug: tenants.slug,
      platformName: tenants.platformName,
      logoUrl: tenants.logoUrl,
      isActive: tenants.isActive,
    })
    .from(userTenants)
    .innerJoin(tenants, eq(userTenants.tenantId, tenants.id))
    .where(eq(userTenants.userId, userId))
    .orderBy(desc(userTenants.lastUsedAt), asc(userTenants.createdAt));

  return rows;
}

/**
 * Devuelve la membresía activa del usuario en el tenant, o null si no existe /
 * está suspendida / el tenant está suspendido. Para el middleware de sesión.
 */
export async function getActiveMembership(
  userId: string,
  tenantId: string,
): Promise<ActiveMembership | null> {
  const [row] = await db
    .select({
      tenantId: userTenants.tenantId,
      role: userTenants.role,
      status: userTenants.status,
      tenant: {
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        platformName: tenants.platformName,
        logoUrl: tenants.logoUrl,
        timezone: tenants.timezone,
        isActive: tenants.isActive,
      },
    })
    .from(userTenants)
    .innerJoin(tenants, eq(userTenants.tenantId, tenants.id))
    .where(and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)))
    .limit(1);

  if (!row) return null;
  if (row.status !== 'active') return null;
  if (!row.tenant.isActive) return null;
  return row;
}

/**
 * Resuelve el tenant activo de un request. Lanza AppError con el motivo exacto
 * para que el cliente pueda ofrecer cambiar de tenant o re-loguear.
 */
export async function requireActiveMembership(
  userId: string,
  tenantId: string,
): Promise<ActiveMembership> {
  const [row] = await db
    .select({
      tenantId: userTenants.tenantId,
      role: userTenants.role,
      status: userTenants.status,
      tenant: {
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        platformName: tenants.platformName,
        logoUrl: tenants.logoUrl,
        timezone: tenants.timezone,
        isActive: tenants.isActive,
      },
    })
    .from(userTenants)
    .innerJoin(tenants, eq(userTenants.tenantId, tenants.id))
    .where(and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)))
    .limit(1);

  if (!row) {
    throw new AppError('Perdiste el acceso a esta organización', 403, 'MEMBERSHIP_REVOKED');
  }
  if (row.status !== 'active') {
    throw new AppError('Tu acceso a esta organización está suspendido', 403, 'MEMBERSHIP_SUSPENDED');
  }
  if (!row.tenant.isActive) {
    throw new AppError('Esta organización está suspendida', 403, 'TENANT_SUSPENDED');
  }
  return row;
}

/** Crea la membresía o la reactiva/actualiza el rol si ya existía. */
export async function ensureMembership(input: {
  userId: string;
  tenantId: string;
  role: UserRole;
}): Promise<void> {
  await db
    .insert(userTenants)
    .values({
      userId: input.userId,
      tenantId: input.tenantId,
      role: input.role,
      status: 'active',
      lastUsedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [userTenants.userId, userTenants.tenantId],
      set: { role: input.role, status: 'active', updatedAt: new Date() },
    });
}

/** Marca la membresía como última usada (alimenta el tenant default del login). */
export async function touchMembership(userId: string, tenantId: string): Promise<void> {
  await db
    .update(userTenants)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)));
}

/** Cantidad de owners activos del tenant (guarda anti "dejar sin owner"). */
export async function countActiveOwners(tenantId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(userTenants)
    .where(
      and(
        eq(userTenants.tenantId, tenantId),
        eq(userTenants.role, 'owner'),
        eq(userTenants.status, 'active'),
      ),
    );
  return row?.total ?? 0;
}

/**
 * Elige el tenant default del login: el último usado y operable; si no hay
 * ninguno usable, la primera membresía activa. `null` si el usuario no tiene
 * ninguna membresía activa (login ok, app muestra "sin acceso").
 */
export function pickDefaultMembership(memberships: MembershipView[]): MembershipView | null {
  const usable = memberships.filter((m) => m.status === 'active' && m.isActive);
  return usable[0] ?? null;
}
