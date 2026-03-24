# SPEC 08: Team Management (Prisma ORM)

> Invitaciones, roles y permisos para equipos que comparten un tenant.

---

## Contexto

El model `TeamInvitation` y los enums `UserRole`, `InvitationStatus` ya están definidos en `prisma/schema.prisma` (SPEC-01). Esta spec define la lógica de invitaciones y permisos.

---

## 1. Team Service con Prisma

### `src/server/services/teamService.ts`

```typescript
import { prisma } from '../lib/prisma.js';
import { AppError } from './authService.js';
import { getSubscription } from './subscriptionService.js';
import { sendTeamInvitationEmail } from './emailService.js';
import { UserRole, UserStatus, InvitationStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const INVITATION_TTL_DAYS = 7;

// =============================================
// LISTAR MIEMBROS DEL EQUIPO
// =============================================
export async function getTeamMembers(tenantId: string) {
    return prisma.user.findMany({
        where: { tenantId },
        select: {
            id: true, email: true, fullName: true, avatarUrl: true,
            role: true, status: true, isVerified: true,
            lastLoginAt: true, createdAt: true,
        },
        orderBy: [
            { role: 'asc' },  // owner primero
            { createdAt: 'asc' },
        ],
    });
}

// =============================================
// INVITAR MIEMBRO
// =============================================
export async function inviteMember(
    tenantId: string,
    invitedBy: string,
    email: string,
    role: 'editor' | 'viewer'
) {
    // 1. Verificar plan
    const sub = await getSubscription(tenantId);
    if (!sub) throw new AppError('Suscripción no encontrada', 402);

    const [memberCount, pendingCount] = await prisma.$transaction([
        prisma.user.count({ where: { tenantId } }),
        prisma.teamInvitation.count({
            where: { tenantId, status: InvitationStatus.pending },
        }),
    ]);

    if (memberCount + pendingCount >= sub.limits.maxTeamMembers) {
        throw new AppError(
            `Tu plan permite hasta ${sub.limits.maxTeamMembers} miembros. ` +
            `Tienes ${memberCount} activos y ${pendingCount} invitaciones pendientes.`,
            429
        );
    }

    // 2. Verificar duplicados
    const normalizedEmail = email.toLowerCase().trim();

    const existingUser = await prisma.user.findFirst({
        where: { email: normalizedEmail, tenantId },
    });
    if (existingUser) throw new AppError('Este usuario ya es parte de tu equipo', 409);

    const existingInvite = await prisma.teamInvitation.findFirst({
        where: { email: normalizedEmail, tenantId, status: InvitationStatus.pending },
    });
    if (existingInvite) throw new AppError('Ya hay una invitación pendiente para este email', 409);

    // 3. Crear invitación con Prisma
    const invitation = await prisma.teamInvitation.create({
        data: {
            tenantId,
            invitedById: invitedBy,
            email: normalizedEmail,
            role: role as UserRole,
            expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
        },
    });

    // 4. Obtener datos para email
    const inviter = await prisma.user.findUnique({
        where: { id: invitedBy },
        include: { tenant: { select: { name: true } } },
    });

    // 5. Enviar email
    sendTeamInvitationEmail(
        normalizedEmail,
        inviter?.fullName || 'Un miembro',
        inviter?.tenant.name || 'Tu equipo',
        role,
        invitation.token
    ).catch(console.error);

    return { message: `Invitación enviada a ${normalizedEmail}` };
}

// =============================================
// ACEPTAR INVITACIÓN
// =============================================
export async function acceptInvitation(
    token: string,
    fullName: string,
    password: string
) {
    const invitation = await prisma.teamInvitation.findFirst({
        where: { token, status: InvitationStatus.pending },
        include: { tenant: { select: { name: true } } },
    });

    if (!invitation) throw new AppError('Invitación inválida o ya utilizada', 400);

    if (new Date() > invitation.expiresAt) {
        await prisma.teamInvitation.update({
            where: { id: invitation.id },
            data: { status: InvitationStatus.expired },
        });
        throw new AppError('Invitación expirada. Solicita una nueva.', 400);
    }

    // Verificar email no registrado en otro tenant
    const existingUser = await prisma.user.findUnique({
        where: { email: invitation.email },
    });
    if (existingUser) {
        throw new AppError('Este email ya está registrado en otra organización.', 409);
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Transacción: crear user + actualizar invitación
    await prisma.$transaction([
        prisma.user.create({
            data: {
                email: invitation.email,
                passwordHash,
                fullName,
                tenantId: invitation.tenantId,
                role: invitation.role,
                status: UserStatus.active,
                isVerified: true,  // Verificado por invitación
            },
        }),
        prisma.teamInvitation.update({
            where: { id: invitation.id },
            data: { status: InvitationStatus.accepted, acceptedAt: new Date() },
        }),
    ]);

    return { message: 'Invitación aceptada. Ya puedes iniciar sesión.' };
}

// =============================================
// CAMBIAR ROL
// =============================================
export async function changeRole(
    tenantId: string,
    requesterId: string,
    targetUserId: string,
    newRole: 'editor' | 'viewer'
) {
    if (requesterId === targetUserId) {
        throw new AppError('No puedes cambiar tu propio rol', 400);
    }

    const target = await prisma.user.findFirst({
        where: { id: targetUserId, tenantId },
    });
    if (!target) throw new AppError('Usuario no encontrado', 404);
    if (target.role === UserRole.owner) {
        throw new AppError('No puedes cambiar el rol del propietario', 403);
    }

    await prisma.user.update({
        where: { id: targetUserId },
        data: { role: newRole as UserRole },
    });

    return { message: 'Rol actualizado' };
}

// =============================================
// REMOVER MIEMBRO
// =============================================
export async function removeMember(
    tenantId: string,
    requesterId: string,
    targetUserId: string
) {
    if (requesterId === targetUserId) {
        throw new AppError('No puedes removerte a ti mismo', 400);
    }

    const target = await prisma.user.findFirst({
        where: { id: targetUserId, tenantId },
    });
    if (!target) throw new AppError('Usuario no encontrado', 404);
    if (target.role === UserRole.owner) {
        throw new AppError('No puedes remover al propietario', 403);
    }

    await prisma.user.delete({ where: { id: targetUserId } });

    return { message: 'Miembro removido del equipo' };
}

// =============================================
// REVOCAR INVITACIÓN
// =============================================
export async function revokeInvitation(tenantId: string, invitationId: string) {
    const result = await prisma.teamInvitation.updateMany({
        where: { id: invitationId, tenantId, status: InvitationStatus.pending },
        data: { status: InvitationStatus.revoked },
    });
    if (result.count === 0) throw new AppError('Invitación no encontrada', 404);
    return { message: 'Invitación revocada' };
}

// =============================================
// LISTAR INVITACIONES PENDIENTES
// =============================================
export async function getPendingInvitations(tenantId: string) {
    return prisma.teamInvitation.findMany({
        where: { tenantId, status: InvitationStatus.pending },
        include: {
            invitedBy: { select: { fullName: true } },
        },
        orderBy: { createdAt: 'desc' },
    });
}
```

---

## 2. Rutas de Team

Se mantienen idénticas a la spec original — llaman a funciones del service que ahora usan Prisma.

---

## 3. Permisos por Rol (sin cambios)

La matriz de permisos y la implementación con `requireRole()` se mantienen idénticas. Los enum values `UserRole.owner`, `UserRole.editor`, `UserRole.viewer` son auto-generados por Prisma.

---

## 4. Ventajas de Prisma en Team Management

```typescript
// 1. INCLUDE para relaciones (reemplaza JOINs manuales)
const invitations = await prisma.teamInvitation.findMany({
    where: { tenantId, status: InvitationStatus.pending },
    include: {
        invitedBy: { select: { fullName: true } },  // JOIN automático
    },
});
// → [{ email, role, invitedBy: { fullName: "Adrian" }, ... }]

// 2. TRANSACCIONES declarativas
await prisma.$transaction([
    prisma.user.create({ data: { ... } }),
    prisma.teamInvitation.update({ where: { id }, data: { ... } }),
]);

// 3. ENUMS type-safe (auto-generados)
import { UserRole, InvitationStatus } from '@prisma/client';
// TypeScript impide pasar valores inválidos

// 4. COUNT directo
const memberCount = await prisma.user.count({ where: { tenantId } });
```

---

## 5. Testing Checklist

- [ ] Listar miembros usa `prisma.user.findMany` con select
- [ ] Invitar verifica límites con `prisma.$transaction` (count user + count invitations)
- [ ] Crear invitación usa `prisma.teamInvitation.create` con enum types
- [ ] Aceptar invitación usa `$transaction` (create user + update invitation)
- [ ] Invitaciones pendientes incluyen `invitedBy.fullName` via Prisma include
- [ ] Cambiar rol valida `UserRole.owner` antes de permitir cambio
- [ ] Remover miembro usa `prisma.user.delete` con verificación de tenant
- [ ] Revocar usa `updateMany` para atomicidad en el filtro compuesto
- [ ] Todos los enums (`UserRole`, `InvitationStatus`) son type-safe
- [ ] Viewer no puede acceder a team endpoints (requireRole middleware)
