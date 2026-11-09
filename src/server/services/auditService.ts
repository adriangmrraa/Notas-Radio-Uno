import { db } from '../db/index.js';
import { auditLog } from '../db/schema/index.js';
import type { Request } from 'express';

// ---------------------------------------------------------------------------
// auditService — punto único de escritura de audit_log (best-effort)
// NUNCA tira el request principal; NUNCA persiste secretos (sanitize recursivo).
// Convención: action namespaced ('auth.login', 'team.invite', 'admin.*', …) y
// impersonatedBy dentro de metadata.
// ---------------------------------------------------------------------------

export interface AuditInput {
    /** userId del actor; null en acciones de sistema/webhook/worker. */
    actorUserId?: string | null;
    /** tenantId afectado; null en acciones de plataforma. */
    tenantId?: string | null;
    action: string;
    ip?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, unknown>;
}

const SECRET_KEY_RE = /token|secret|password|credential|apikey|api_key|authorization|cookie|private/i;

function sanitizeMetadata(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sanitizeMetadata);
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : sanitizeMetadata(v);
        }
        return out;
    }
    return value;
}

/**
 * Escribe una entrada en audit_log. Best-effort: errores se loguean como
 * warning y nunca propagan al request.
 */
export async function audit(input: AuditInput): Promise<void> {
    try {
        await db.insert(auditLog).values({
            tenantId: input.tenantId ?? null,
            userId: input.actorUserId ?? null,
            action: input.action,
            ipAddress: input.ip ?? null,
            userAgent: input.userAgent ?? null,
            metadata: (sanitizeMetadata(input.metadata ?? {}) as Record<string, unknown>),
        });
    } catch (err) {
        console.warn(`[Audit] write failed for action '${input.action}' (best-effort):`, err);
    }
}

/** Convenience: audit desde un Express request autenticado. */
export async function auditRequest(
    req: Request,
    action: string,
    metadata: Record<string, unknown> = {},
): Promise<void> {
    await audit({
        actorUserId: req.auth?.userId ?? null,
        tenantId: req.auth?.tenantId ?? null,
        action,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
        metadata,
    });
}

/**
 * Registra un `forbidden_attempt` — se invoca desde guards de rol (403).
 * No await en el caller: fire-and-forget para no bloquear la respuesta.
 */
export function auditForbiddenAttempt(req: Request, requiredRoles: string[]): void {
    void audit({
        actorUserId: req.auth?.userId ?? null,
        tenantId: req.auth?.tenantId ?? null,
        action: 'forbidden_attempt',
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
        metadata: {
            method: req.method,
            path: req.originalUrl ?? req.url,
            role: req.auth?.role ?? null,
            requiredRoles,
        },
    });
}
