/**
 * emailTemplates.ts — Plantilla única de emails transaccionales (PH-06)
 *
 * Un solo layout con branding para los 10 emails de la plataforma:
 *  - Header con el logo del tenant cuando hay URL PÚBLICA (`tenants.logo_url`);
 *    los logos blob viven detrás de `/api/branding/logo` (auth) y NO son
 *    embebibles en un mail → fallback a monograma de texto.
 *  - Color de acento por tenant (`tenants.config.brandColor`, mismo jsonb de
 *    claves libres que ya usa `imageModel`/`pendingPlan`/`extraTransmissions`)
 *    o el default de plataforma.
 *  - Pie con razón social, enlaces legales y el motivo del envío
 *    ("te llegó este email porque...").
 *
 * Compatibilidad de clientes de correo: layout de tablas + estilos INLINE en
 * cada elemento (nada de <style>, flexbox ni clases).
 *
 * `renderEmail` es puro: devuelve { html, text } sin enviar nada, así el
 * render se testea sin SMTP.
 */

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// ── Branding ──────────────────────────────────────────────────────────────────

export interface EmailLink {
  label: string;
  url: string;
}

export interface EmailBranding {
  /** Nombre visible de la marca en el header y en la firma de texto. */
  brandName: string;
  /** Color de acento del CTA y del monograma. Hex `#rgb`/`#rrggbb`. */
  accentColor: string;
  /** URL pública del logo. `null` → monograma de texto. */
  logoUrl: string | null;
  /** Razón social del operador (línea legal del pie). */
  legalName: string;
  /** Base pública del frontend: links del pie y de los CTAs. */
  frontendUrl: string;
  /** Enlaces legales del pie. */
  legalLinks: EmailLink[];
}

function defaultLegalLinks(frontendUrl: string): EmailLink[] {
  return [
    { label: 'Términos y Condiciones', url: `${frontendUrl}/terms` },
    { label: 'Política de Privacidad', url: `${frontendUrl}/privacy` },
  ];
}

/** Defaults de plataforma: único lugar donde viven. */
export const PLATFORM_EMAIL_BRANDING: EmailBranding = {
  brandName: 'PeriodistApp',
  accentColor: '#6366f1',
  logoUrl: null,
  legalName: 'PeriodistApp',
  frontendUrl: FRONTEND_URL,
  legalLinks: defaultLegalLinks(FRONTEND_URL),
};

function compactDefined<T extends object>(obj?: Partial<T>): Partial<T> {
  const out: Record<string, unknown> = {};
  if (obj) {
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) out[key] = value;
    }
  }
  return out as Partial<T>;
}

/**
 * Resuelve un branding parcial contra los defaults de plataforma.
 * Si no se pasan `legalLinks` explícitos se derivan del `frontendUrl`
 * efectivo (así un override de URL no deja links apuntando a otro host).
 */
export function mergeBranding(branding?: Partial<EmailBranding>): EmailBranding {
  const merged: EmailBranding = {
    ...PLATFORM_EMAIL_BRANDING,
    ...compactDefined(branding),
  };
  if (!branding?.legalLinks) {
    merged.legalLinks = defaultLegalLinks(merged.frontendUrl);
  }
  return merged;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function monogram(name: string): string {
  const initials = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
  return escapeHtml(initials || 'P');
}

const BODY_FONT = "Arial, Helvetica, sans-serif";

// ── Layout ────────────────────────────────────────────────────────────────────

export interface EmailRenderInput {
  /** Título dentro de la tarjeta (equivale al <h2> de los mails viejos). */
  heading: string;
  /** Cuerpo en HTML (los builders ya escapan sus variables). */
  bodyHtml: string;
  /** Cuerpo en texto plano: mismos datos clave que el HTML. */
  bodyText: string;
  /** Botón de acción opcional. */
  cta?: { label: string; url: string };
  /** Motivo del envío para el pie ("te llegó este email porque..."). */
  reason: string;
  branding?: Partial<EmailBranding>;
}

/**
 * Envuelve el contenido en el layout de marca y devuelve ambas versiones.
 * No envía nada: el envío queda en `emailService.sendEmail`.
 */
export function renderEmail(input: EmailRenderInput): { html: string; text: string } {
  const b = mergeBranding(input.branding);

  const mark = b.logoUrl
    ? `<img src="${escapeHtml(b.logoUrl)}" alt="${escapeHtml(b.brandName)}" width="36" height="36" style="display:inline-block;vertical-align:middle;border-radius:8px;object-fit:contain;" />`
    : `<span style="display:inline-block;vertical-align:middle;width:36px;height:36px;border-radius:8px;background-color:${b.accentColor};color:#ffffff;font-family:${BODY_FONT};font-size:15px;font-weight:bold;line-height:36px;text-align:center;">${monogram(b.brandName)}</span>`;

  const ctaBlock = input.cta
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td align="center" style="padding:24px 0 8px;">
          <a href="${escapeHtml(input.cta.url)}" style="display:inline-block;background-color:${b.accentColor};color:#ffffff;padding:12px 32px;text-decoration:none;border-radius:8px;font-weight:bold;font-family:${BODY_FONT};font-size:15px;">
            ${escapeHtml(input.cta.label)}
          </a>
        </td></tr>
        <tr><td align="center" style="padding:4px 0 0;">
          <p style="margin:0;color:#94a3b8;font-size:12px;font-family:${BODY_FONT};word-break:break-all;">
            Si el botón no funciona, copiá esta dirección: ${escapeHtml(input.cta.url)}
          </p>
        </td></tr>
      </table>`
    : '';

  const legalLinksHtml = b.legalLinks
    .map(
      (link) =>
        `<a href="${escapeHtml(link.url)}" style="color:#64748b;text-decoration:underline;">${escapeHtml(link.label)}</a>`,
    )
    .join(' &middot; ');

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(b.brandName)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;">
<span style="display:none;max-height:0;overflow:hidden;color:#f1f5f9;">${escapeHtml(input.heading)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f1f5f9;">
  <tr><td align="center" style="padding:24px 16px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;">
      <tr><td style="padding:4px 8px 16px;">
        ${mark}
        <span style="display:inline-block;vertical-align:middle;margin-left:10px;font-family:${BODY_FONT};font-size:18px;font-weight:bold;color:#0f172a;">${escapeHtml(b.brandName)}</span>
      </td></tr>
      <tr><td style="background-color:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;">
        <h1 style="margin:0 0 16px;font-family:${BODY_FONT};font-size:22px;font-weight:bold;color:#0f172a;">${escapeHtml(input.heading)}</h1>
        <div style="font-family:${BODY_FONT};font-size:15px;line-height:1.5;color:#334155;">
          ${input.bodyHtml}
        </div>
        ${ctaBlock}
      </td></tr>
      <tr><td style="padding:20px 16px 8px;text-align:center;font-family:${BODY_FONT};font-size:12px;line-height:1.5;color:#64748b;">
        <p style="margin:0 0 8px;">${escapeHtml(input.reason)}</p>
        <p style="margin:0 0 8px;">${escapeHtml(b.legalName)} &middot; <a href="${escapeHtml(b.frontendUrl)}" style="color:#64748b;text-decoration:underline;">${escapeHtml(b.frontendUrl)}</a></p>
        <p style="margin:0;">${legalLinksHtml}</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    input.heading,
    '',
    input.bodyText,
    ...(input.cta ? ['', `${input.cta.label}: ${input.cta.url}`] : []),
    '',
    '—',
    input.reason,
    `${b.brandName} — ${b.frontendUrl}`,
    b.legalName,
    ...b.legalLinks.map((link) => `${link.label}: ${link.url}`),
  ].join('\n');

  return { html, text };
}

// ── Builders (uno por tipo de email) ──────────────────────────────────────────
// Cada builder conserva subject, links, datos y copia del email original.

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

interface BrandedInput {
  branding?: Partial<EmailBranding>;
}

const P_STYLE = 'margin:0 0 12px;';
const MUTED_STYLE = 'margin:0 0 12px;color:#64748b;font-size:14px;';

export function buildVerificationEmail(input: {
  name: string;
  token: string;
} & BrandedInput): BuiltEmail {
  const b = mergeBranding(input.branding);
  const url = `${b.frontendUrl}/verify-email?token=${input.token}`;
  const { html, text } = renderEmail({
    branding: b,
    heading: `Hola ${input.name}!`,
    reason: `Te llegó este email porque creaste una cuenta en ${b.brandName}.`,
    cta: { label: 'Verificar mi email', url },
    bodyHtml: `
      <p style="${P_STYLE}">Gracias por registrarte en PeriodistApp. Para activar tu cuenta, haz clic en el siguiente enlace:</p>
      <p style="${MUTED_STYLE}">Este enlace expira en 48 horas.</p>
      <p style="${MUTED_STYLE}">Si no creaste esta cuenta, ignora este email.</p>`,
    bodyText: [
      'Gracias por registrarte en PeriodistApp. Para activar tu cuenta, abrí este enlace:',
      url,
      '',
      'Este enlace expira en 48 horas.',
      'Si no creaste esta cuenta, ignora este email.',
    ].join('\n'),
  });
  return { subject: 'Verifica tu cuenta - PeriodistApp', html, text };
}

export function buildWelcomeEmail(input: {
  name: string;
} & BrandedInput): BuiltEmail {
  const b = mergeBranding(input.branding);
  const url = `${b.frontendUrl}/dashboard`;
  const { html, text } = renderEmail({
    branding: b,
    heading: `Bienvenido ${input.name}!`,
    reason: `Te llegó este email porque tu cuenta de ${b.brandName} quedó verificada.`,
    cta: { label: 'Ir al Dashboard', url },
    bodyHtml: `
      <p style="${P_STYLE}">Tu cuenta ha sido verificada exitosamente. Ya puedes comenzar a usar PeriodistApp.</p>
      <p style="${P_STYLE}">Tu periodo de prueba gratuito de 7 dias ha comenzado. Durante este tiempo tendras acceso a:</p>
      <ul style="margin:0 0 12px;padding-left:20px;">
        <li>5 horas de procesamiento de pipeline</li>
        <li>20 publicaciones</li>
        <li>2 agentes custom</li>
        <li>Generacion de imagenes con IA</li>
      </ul>`,
    bodyText: [
      'Tu cuenta ha sido verificada exitosamente. Ya puedes comenzar a usar PeriodistApp.',
      '',
      'Tu periodo de prueba gratuito de 7 dias ha comenzado. Durante este tiempo tendras acceso a:',
      '- 5 horas de procesamiento de pipeline',
      '- 20 publicaciones',
      '- 2 agentes custom',
      '- Generacion de imagenes con IA',
    ].join('\n'),
  });
  return { subject: 'Bienvenido a PeriodistApp!', html, text };
}

export function buildPasswordResetEmail(input: {
  name: string;
  token: string;
} & BrandedInput): BuiltEmail {
  const b = mergeBranding(input.branding);
  const url = `${b.frontendUrl}/reset-password?token=${input.token}`;
  const { html, text } = renderEmail({
    branding: b,
    heading: `Hola ${input.name}`,
    reason: `Te llegó este email porque se pidió un reseteo de contraseña para tu cuenta de ${b.brandName}.`,
    cta: { label: 'Resetear contrasena', url },
    bodyHtml: `
      <p style="${P_STYLE}">Recibimos una solicitud para resetear tu contrasena. Haz clic en el siguiente enlace:</p>
      <p style="${MUTED_STYLE}">Este enlace expira en 1 hora.</p>
      <p style="${MUTED_STYLE}">Si no solicitaste esto, ignora este email.</p>`,
    bodyText: [
      'Recibimos una solicitud para resetear tu contrasena. Abrí este enlace:',
      url,
      '',
      'Este enlace expira en 1 hora.',
      'Si no solicitaste esto, ignora este email.',
    ].join('\n'),
  });
  return { subject: 'Resetear contrasena - PeriodistApp', html, text };
}

export function buildTeamInviteEmail(input: {
  tenantName: string;
  inviterName: string;
  role: string;
  token: string;
  expiresInHours: number;
} & BrandedInput): BuiltEmail {
  const b = mergeBranding(input.branding);
  const url = `${b.frontendUrl}/accept-invite?token=${input.token}`;
  const roleLabel = input.role === 'viewer' ? 'lector (solo lectura)' : 'editor';
  const { html, text } = renderEmail({
    branding: b,
    heading: 'Hola!',
    reason: `Te llegó este email porque te invitaron a un equipo de ${b.brandName}.`,
    cta: { label: 'Aceptar invitación', url },
    bodyHtml: `
      <p style="${P_STYLE}"><strong>${escapeHtml(input.inviterName)}</strong> te invitó a sumarte al equipo de
      <strong>${escapeHtml(input.tenantName)}</strong> en PeriodistApp como <strong>${escapeHtml(roleLabel)}</strong>.</p>
      <p style="${MUTED_STYLE}">Este enlace expira en ${escapeHtml(input.expiresInHours)} horas.</p>
      <p style="${MUTED_STYLE}">Si no esperabas esta invitación, ignorá este email.</p>`,
    bodyText: [
      `${input.inviterName} te invitó a sumarte al equipo de ${input.tenantName} en PeriodistApp como ${roleLabel}.`,
      '',
      `Aceptá la invitación acá: ${url}`,
      '',
      `Este enlace expira en ${input.expiresInHours} horas.`,
      'Si no esperabas esta invitación, ignorá este email.',
    ].join('\n'),
  });
  return { subject: `Te invitaron a ${input.tenantName} - PeriodistApp`, html, text };
}

export function buildTrialEndingEmail(input: {
  name: string;
  daysLeft: number;
} & BrandedInput): BuiltEmail {
  const b = mergeBranding(input.branding);
  const url = `${b.frontendUrl}/billing`;
  const dayLabel = input.daysLeft === 1 ? 'día' : 'días';
  const { html, text } = renderEmail({
    branding: b,
    heading: `Hola ${input.name}!`,
    reason: `Te llegó este email porque tu período de prueba en ${b.brandName} está por terminar.`,
    cta: { label: 'Elegir un plan', url },
    bodyHtml: `
      <p style="${P_STYLE}">Tu período de prueba en PeriodistApp termina en <strong>${escapeHtml(input.daysLeft)} ${dayLabel}</strong>.</p>
      <p style="${P_STYLE}">Para seguir transmitiendo sin interrupciones, elegí un plan que se ajuste a tu operación.</p>`,
    bodyText: [
      `Tu período de prueba en PeriodistApp termina en ${input.daysLeft} ${dayLabel}.`,
      '',
      `Para seguir transmitiendo sin interrupciones, elegí un plan: ${url}`,
    ].join('\n'),
  });
  return {
    subject: `Tu prueba termina en ${input.daysLeft} ${dayLabel} - PeriodistApp`,
    html,
    text,
  };
}

export function buildTrialExpiredEmail(input: {
  name: string;
} & BrandedInput): BuiltEmail {
  const b = mergeBranding(input.branding);
  const url = `${b.frontendUrl}/billing`;
  const { html, text } = renderEmail({
    branding: b,
    heading: `Hola ${input.name}`,
    reason: `Te llegó este email porque tu período de prueba en ${b.brandName} terminó.`,
    cta: { label: 'Ver planes', url },
    bodyHtml: `
      <p style="${P_STYLE}">Tu período de prueba en PeriodistApp terminó. Tus notas, clips e historial siguen disponibles,
      pero ya no podés iniciar nuevas transmisiones.</p>
      <p style="${P_STYLE}">Elegí un plan para volver a transmitir.</p>`,
    bodyText: [
      'Tu período de prueba en PeriodistApp terminó. Tus notas, clips e historial siguen disponibles,',
      'pero ya no podés iniciar nuevas transmisiones.',
      '',
      `Elegí un plan para volver a transmitir: ${url}`,
    ].join('\n'),
  });
  return { subject: 'Tu prueba terminó - PeriodistApp', html, text };
}

export function buildPaymentSucceededEmail(input: {
  name: string;
  amount: number | string;
  currency: string;
  planDisplayName: string;
} & BrandedInput): BuiltEmail {
  const b = mergeBranding(input.branding);
  const url = `${b.frontendUrl}/billing`;
  const { html, text } = renderEmail({
    branding: b,
    heading: `Gracias ${input.name}!`,
    reason: `Te llegó este email porque recibimos un pago de tu suscripción a ${b.brandName}.`,
    cta: { label: 'Ver mi facturación', url },
    bodyHtml: `
      <p style="${P_STYLE}">Recibimos tu pago de <strong>${escapeHtml(input.amount)} ${escapeHtml(input.currency)}</strong> por el plan <strong>${escapeHtml(input.planDisplayName)}</strong>.</p>
      <p style="${P_STYLE}">Tu suscripción está activa y tu cuota de transmisiones ya está disponible.</p>`,
    bodyText: [
      `Recibimos tu pago de ${input.amount} ${input.currency} por el plan ${input.planDisplayName}.`,
      '',
      `Tu suscripción está activa y tu cuota de transmisiones ya está disponible.`,
      `Tu facturación: ${url}`,
    ].join('\n'),
  });
  return { subject: 'Pago recibido - PeriodistApp', html, text };
}

export function buildPaymentFailedEmail(input: {
  name: string;
  attempt: number;
  graceEndsAt: Date;
} & BrandedInput): BuiltEmail {
  const b = mergeBranding(input.branding);
  const url = `${b.frontendUrl}/billing`;
  const date = input.graceEndsAt.toLocaleDateString('es-AR');
  const { html, text } = renderEmail({
    branding: b,
    heading: `Hola ${input.name}`,
    reason: `Te llegó este email porque no pudimos cobrar tu suscripción a ${b.brandName}.`,
    cta: { label: 'Actualizar medio de pago', url },
    bodyHtml: `
      <p style="${P_STYLE}">No pudimos procesar el pago de tu suscripción (intento <strong>${escapeHtml(input.attempt)}</strong>).</p>
      <p style="${P_STYLE}">Tu servicio sigue activo hasta el <strong>${escapeHtml(date)}</strong>. Después de esa fecha la cuenta se suspende.</p>
      <p style="${P_STYLE}">Actualizá tu medio de pago para evitar la suspensión.</p>`,
    bodyText: [
      `No pudimos procesar el pago de tu suscripción (intento ${input.attempt}).`,
      `Tu servicio sigue activo hasta el ${date}. Después de esa fecha la cuenta se suspende.`,
      '',
      `Actualizá tu medio de pago para evitar la suspensión: ${url}`,
    ].join('\n'),
  });
  return { subject: 'No pudimos cobrar tu suscripción - PeriodistApp', html, text };
}

export function buildAddonPurchasedEmail(input: {
  name: string;
  transmissions: number;
  expiresAt: Date;
} & BrandedInput): BuiltEmail {
  const b = mergeBranding(input.branding);
  const url = `${b.frontendUrl}/billing`;
  const date = input.expiresAt.toLocaleDateString('es-AR');
  const { html, text } = renderEmail({
    branding: b,
    heading: `Listo ${input.name}!`,
    reason: `Te llegó este email porque compraste transmisiones adicionales en ${b.brandName}.`,
    cta: { label: 'Ver mi uso', url },
    bodyHtml: `
      <p style="${P_STYLE}">Acreditamos <strong>${escapeHtml(input.transmissions)} transmisiones</strong> adicionales a tu ciclo vigente.</p>
      <p style="${P_STYLE}">Están disponibles hasta el <strong>${escapeHtml(date)}</strong> (fin del ciclo actual) y no se acumulan al siguiente período.</p>`,
    bodyText: [
      `Acreditamos ${input.transmissions} transmisiones adicionales a tu ciclo vigente.`,
      `Están disponibles hasta el ${date} (fin del ciclo actual) y no se acumulan al siguiente período.`,
      '',
      `Tu uso: ${url}`,
    ].join('\n'),
  });
  return {
    subject: `+${input.transmissions} transmisiones acreditadas - PeriodistApp`,
    html,
    text,
  };
}

export function buildSubscriptionSuspendedEmail(input: {
  name: string;
} & BrandedInput): BuiltEmail {
  const b = mergeBranding(input.branding);
  const url = `${b.frontendUrl}/billing`;
  const { html, text } = renderEmail({
    branding: b,
    heading: `Hola ${input.name}`,
    reason: `Te llegó este email porque tu suscripción a ${b.brandName} fue suspendida.`,
    cta: { label: 'Regularizar pago', url },
    bodyHtml: `
      <p style="${P_STYLE}">Tu suscripción de PeriodistApp quedó <strong>suspendida</strong> por falta de pago.</p>
      <p style="${P_STYLE}">Tus notas, clips e historial se conservan. Para volver a transmitir, regularizá el pago.</p>`,
    bodyText: [
      'Tu suscripción de PeriodistApp quedó suspendida por falta de pago.',
      'Tus notas, clips e historial se conservan.',
      '',
      `Para volver a transmitir, regularizá el pago: ${url}`,
    ].join('\n'),
  });
  return { subject: 'Tu suscripción fue suspendida - PeriodistApp', html, text };
}
