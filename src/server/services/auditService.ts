/**
 * auditService.ts — Registro de acciones sensibles
 *
 * Toda acción sensible (login, publish, cambios de admin/billing, impersonación,
 * denegaciones de autorización) escribe en `audit_log`. El registro NUNCA debe
 * romper el flujo principal: si falla el insert se loguea y sigue.
 */

import type { Request } from 'express';
import { db } from '../db/index.js';
import { auditLog } from '../db/schema/index.js';

export type AuditOutcome = 'success' | 'denied' | 'error';

export interface AuditEventInput {
  action: string;
  tenantId?: string | null;
  userId?: string | null;
  actorRole?: string | null;
  actorEmail?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  outcome?: AuditOutcome;
  impersonatedByUserId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/** Acciones auditadas. Prefijo por dominio para poder filtrar en el admin. */
export const AUDIT_ACTIONS = {
  LOGIN_SUCCESS: 'auth.login',
  LOGIN_FAILED: 'auth.login_failed',
  LOGIN_BLOCKED: 'auth.login_blocked',
  LOGOUT: 'auth.logout',
  REGISTER: 'auth.register',
  EMAIL_VERIFIED: 'auth.email_verified',
  PASSWORD_RESET_REQUEST: 'auth.password_reset_request',
  PASSWORD_RESET: 'auth.password_reset',
  TENANT_SWITCHED: 'auth.tenant_switched',
  AUTHZ_DENIED: 'authz.denied',

  INVITE_CREATED: 'team.invite_created',
  INVITE_RESENT: 'team.invite_resent',
  INVITE_REVOKED: 'team.invite_revoked',
  INVITE_ACCEPTED: 'team.invite_accepted',
  MEMBER_ROLE_CHANGED: 'team.role_changed',
  MEMBER_REMOVED: 'team.member_removed',

  PUBLISH: 'publication.publish',
  PUBLISH_FAILED: 'publication.publish_failed',
  PUBLICATION_APPROVED: 'publication.approved',
  PUBLICATION_REJECTED: 'publication.rejected',
  PUBLISH_CHANNEL_MODE_CHANGED: 'publish_channel.mode_changed',
  PUBLISH_CHANNEL_LEGACY_ONLY_CHANGED: 'publish_channel.legacy_only_changed',

  BILLING_PLAN_CHANGED: 'billing.plan_changed',
  BILLING_CHECKOUT: 'billing.checkout',
  BILLING_PAYMENT_OK: 'billing.payment_succeeded',
  BILLING_PAYMENT_FAILED: 'billing.payment_failed',

  ADMIN_TENANT_UPDATED: 'admin.tenant_updated',
  ADMIN_PLAN_CHANGED: 'admin.plan_changed',
  ADMIN_TRIAL_EXTENDED: 'admin.trial_extended',
  ADMIN_QUOTA_GRANTED: 'admin.quota_granted',
  ADMIN_TENANT_SUSPENDED: 'admin.tenant_suspended',
  ADMIN_TENANT_REACTIVATED: 'admin.tenant_reactivated',
  ADMIN_FEATURE_OVERRIDE: 'admin.feature_override',
  ADMIN_JOB_REQUEUED: 'admin.job_requeued',
  ADMIN_BACKUP_SYNCED: 'admin.backup_synced',
  CREDENTIAL_UPDATED: 'credentials.updated',
  CREDENTIAL_DELETED: 'credentials.deleted',

  ADMIN_IMPERSONATION_START: 'admin.impersonation_start',
  ADMIN_IMPERSONATION_END: 'admin.impersonation_end',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** Escribe un evento de auditoría. Nunca lanza. */
export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  try {
    await db.insert(auditLog).values({
      tenantId: input.tenantId ?? null,
      userId: input.userId ?? null,
      action: input.action,
      actorRole: input.actorRole ?? null,
      actorEmail: input.actorEmail ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      outcome: input.outcome ?? 'success',
      impersonatedByUserId: input.impersonatedByUserId ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      metadata: input.metadata ?? {},
    });
  } catch (err) {
    console.error('[Audit] No se pudo registrar el evento', input.action, err);
  }
}

/** Deriva actor, tenant, IP y user-agent del request autenticado. */
export function auditFromRequest(
  req: Request,
  action: string,
  extra: Omit<AuditEventInput, 'action' | 'tenantId' | 'userId' | 'actorRole' | 'ipAddress' | 'userAgent'> = {},
): Promise<void> {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
    || req.socket.remoteAddress
    || null;

  return recordAuditEvent({
    action,
    tenantId: req.auth?.tenantId ?? null,
    userId: req.auth?.userId ?? null,
    actorRole: req.auth?.role ?? null,
    actorEmail: req.auth?.email ?? null,
    ipAddress: ip,
    userAgent: req.headers['user-agent'] ?? null,
    ...extra,
  });
}
