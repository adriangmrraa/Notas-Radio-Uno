import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants } from '../db/schema/index.js';
import {
    buildVerificationEmail,
    buildWelcomeEmail,
    buildPasswordResetEmail,
    buildTeamInviteEmail,
    buildTrialEndingEmail,
    buildTrialExpiredEmail,
    buildPaymentSucceededEmail,
    buildPaymentFailedEmail,
    buildAddonPurchasedEmail,
    buildSubscriptionSuspendedEmail,
    type EmailBranding,
} from './emailTemplates.js';

const SMTP_FROM = process.env.SMTP_FROM || 'PeriodistApp <noreply@periodistapp.com>';

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'localhost',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    } : undefined,
});

interface EmailContent {
    html: string;
    text: string;
}

async function sendEmail(to: string, subject: string, content: EmailContent): Promise<void> {
    if (!process.env.SMTP_HOST) {
        console.log(`[Email] SMTP no configurado. Email a ${to}: ${subject}`);
        return;
    }

    await transporter.sendMail({
        from: SMTP_FROM,
        to,
        subject,
        html: content.html,
        text: content.text,
    });
}

// ── Branding por tenant ───────────────────────────────────────────────────────
//
// Fuente real del branding (verificado en código):
//  - `tenants.platformName` (fallback `tenants.name`) → nombre de marca.
//  - `tenants.logoUrl` → URL pública del logo. El blob `logoData` NO sirve
//    para email: se expone en /api/branding/logo detrás de auth, así que sin
//    URL pública el layout cae al monograma de texto.
//  - `tenants.config.brandColor` → color de acento (jsonb de claves libres,
//    mismo mecanismo que `imageModel`, `pendingPlan`, `extraTransmissions`).
// Sin tenant, sin fila o sin config → defaults de plataforma (mergeBranding).

const BRAND_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export async function resolveEmailBranding(tenantId?: string | null): Promise<Partial<EmailBranding>> {
    if (!tenantId) return {};

    try {
        const [tenant] = await db
            .select({
                name: tenants.name,
                platformName: tenants.platformName,
                logoUrl: tenants.logoUrl,
                config: tenants.config,
            })
            .from(tenants)
            .where(eq(tenants.id, tenantId))
            .limit(1);

        if (!tenant) return {};

        const config = (tenant.config && typeof tenant.config === 'object'
            ? tenant.config
            : {}) as Record<string, unknown>;
        const accentColor = typeof config.brandColor === 'string' && BRAND_COLOR_RE.test(config.brandColor)
            ? config.brandColor
            : undefined;

        return {
            brandName: tenant.platformName || tenant.name || undefined,
            logoUrl: tenant.logoUrl ?? null,
            accentColor,
        };
    } catch (err) {
        // El branding nunca tumba un envío: ante error de DB sale plataforma.
        console.error('[Email] No se pudo resolver el branding del tenant:', err);
        return {};
    }
}

/** Opcional en todos los senders: con tenantId el mail sale brandeado. */
interface SendOptions {
    tenantId?: string | null;
}

export async function sendVerificationEmail(
    email: string,
    name: string,
    token: string,
    opts?: SendOptions,
): Promise<void> {
    const branding = await resolveEmailBranding(opts?.tenantId);
    const built = buildVerificationEmail({ name, token, branding });
    await sendEmail(email, built.subject, built);
}

export async function sendWelcomeEmail(
    email: string,
    name: string,
    opts?: SendOptions,
): Promise<void> {
    const branding = await resolveEmailBranding(opts?.tenantId);
    const built = buildWelcomeEmail({ name, branding });
    await sendEmail(email, built.subject, built);
}

export async function sendPasswordResetEmail(
    email: string,
    name: string,
    token: string,
    opts?: SendOptions,
): Promise<void> {
    const branding = await resolveEmailBranding(opts?.tenantId);
    const built = buildPasswordResetEmail({ name, token, branding });
    await sendEmail(email, built.subject, built);
}

/**
 * Invitación a sumarse al equipo de un tenant.
 * El token viaja en el link: es la única prueba de identidad necesaria para
 * aceptar (el mail ya validó el email del invitado).
 */
export async function sendTeamInviteEmail(
    email: string,
    opts: {
        tenantName: string;
        inviterName: string;
        role: string;
        token: string;
        expiresInHours: number;
        tenantId?: string | null;
    },
): Promise<void> {
    const branding = await resolveEmailBranding(opts.tenantId);
    const built = buildTeamInviteEmail({
        tenantName: opts.tenantName,
        inviterName: opts.inviterName,
        role: opts.role,
        token: opts.token,
        expiresInHours: opts.expiresInHours,
        branding,
    });
    await sendEmail(email, built.subject, built);
}

// ── Emails del ciclo de vida de suscripción (Épica B) ─────────────────────────
// Todos pasan por sendEmail: sin SMTP configurado son no-op (log local).

export async function sendTrialEndingEmail(
    email: string,
    name: string,
    daysLeft: number,
    opts?: SendOptions,
): Promise<void> {
    const branding = await resolveEmailBranding(opts?.tenantId);
    const built = buildTrialEndingEmail({ name, daysLeft, branding });
    await sendEmail(email, built.subject, built);
}

export async function sendTrialExpiredEmail(
    email: string,
    name: string,
    opts?: SendOptions,
): Promise<void> {
    const branding = await resolveEmailBranding(opts?.tenantId);
    const built = buildTrialExpiredEmail({ name, branding });
    await sendEmail(email, built.subject, built);
}

export async function sendPaymentSucceededEmail(
    email: string,
    name: string,
    amount: number | string,
    currency: string,
    planDisplayName: string,
    opts?: SendOptions,
): Promise<void> {
    const branding = await resolveEmailBranding(opts?.tenantId);
    const built = buildPaymentSucceededEmail({ name, amount, currency, planDisplayName, branding });
    await sendEmail(email, built.subject, built);
}

export async function sendPaymentFailedEmail(
    email: string,
    name: string,
    attempt: number,
    graceEndsAt: Date,
    opts?: SendOptions,
): Promise<void> {
    const branding = await resolveEmailBranding(opts?.tenantId);
    const built = buildPaymentFailedEmail({ name, attempt, graceEndsAt, branding });
    await sendEmail(email, built.subject, built);
}

export async function sendAddonPurchasedEmail(
    email: string,
    name: string,
    transmissions: number,
    expiresAt: Date,
    opts?: SendOptions,
): Promise<void> {
    const branding = await resolveEmailBranding(opts?.tenantId);
    const built = buildAddonPurchasedEmail({ name, transmissions, expiresAt, branding });
    await sendEmail(email, built.subject, built);
}

export async function sendSubscriptionSuspendedEmail(
    email: string,
    name: string,
    opts?: SendOptions,
): Promise<void> {
    const branding = await resolveEmailBranding(opts?.tenantId);
    const built = buildSubscriptionSuspendedEmail({ name, branding });
    await sendEmail(email, built.subject, built);
}
