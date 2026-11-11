/**
 * PH-06 — Emails con branding de plataforma.
 *
 * `renderEmail` y los 10 builders son puros (no envían, no tocan DB):
 * el test verifica branding de tenant, fallback de plataforma, paridad
 * de datos clave entre html y text, y el pie transaccional.
 */
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_EMAIL_BRANDING,
  buildAddonPurchasedEmail,
  buildPasswordResetEmail,
  buildPaymentFailedEmail,
  buildPaymentSucceededEmail,
  buildSubscriptionSuspendedEmail,
  buildTeamInviteEmail,
  buildTrialEndingEmail,
  buildTrialExpiredEmail,
  buildVerificationEmail,
  buildWelcomeEmail,
  mergeBranding,
  renderEmail,
  type BuiltEmail,
  type EmailBranding,
} from '../src/server/services/emailTemplates';

const TENANT_BRAND: Partial<EmailBranding> = {
  brandName: 'Radio Formosa',
  accentColor: '#e11d48',
  logoUrl: 'https://cdn.radioformosa.example/logo.png',
};

describe('mergeBranding', () => {
  it('sin input → defaults de plataforma completos', () => {
    const b = mergeBranding();
    expect(b).toEqual(PLATFORM_EMAIL_BRANDING);
    expect(b.brandName).toBe('PeriodistApp');
    expect(b.accentColor).toBe('#6366f1');
    expect(b.logoUrl).toBeNull();
    expect(b.legalLinks.length).toBeGreaterThan(0);
  });

  it('ignora claves con undefined y deriva legalLinks del frontendUrl efectivo', () => {
    const b = mergeBranding({ frontendUrl: 'https://app.radio.example', logoUrl: undefined });
    expect(b.frontendUrl).toBe('https://app.radio.example');
    expect(b.logoUrl).toBeNull();
    expect(b.legalLinks.every((l) => l.url.startsWith('https://app.radio.example'))).toBe(true);
  });
});

describe('renderEmail — layout de marca', () => {
  it('con branding de tenant: usa logo <img>, color de acento y nombre de marca', () => {
    const { html, text } = renderEmail({
      heading: 'Hola Ana!',
      bodyHtml: '<p>Contenido</p>',
      bodyText: 'Contenido',
      reason: 'Te llegó este email porque test.',
      cta: { label: 'Verificar', url: 'https://app.radio.example/verify?token=abc' },
      branding: TENANT_BRAND,
    });

    expect(html).toContain('https://cdn.radioformosa.example/logo.png');
    expect(html).toContain('Radio Formosa');
    expect(html).toContain('#e11d48');
    expect(html).toContain('https://app.radio.example/verify?token=abc');
    expect(text).toContain('Radio Formosa');
    expect(text).toContain('https://app.radio.example/verify?token=abc');
  });

  it('sin branding: defaults de plataforma, monograma (sin <img>) y no rompe', () => {
    const { html, text } = renderEmail({
      heading: 'Hola!',
      bodyHtml: '<p>Contenido</p>',
      bodyText: 'Contenido',
      reason: 'Te llegó este email porque test.',
    });

    expect(html).toContain('PeriodistApp');
    expect(html).toContain('#6366f1');
    expect(html).not.toContain('<img');
    // Monograma: "P" de PeriodistApp en el header.
    expect(html).toContain('>P</span>');
    expect(text).toContain('PeriodistApp');
  });

  it('logo blob autenticado (sin URL pública) cae al monograma del tenant', () => {
    const { html } = renderEmail({
      heading: 'Hola!',
      bodyHtml: '<p>x</p>',
      bodyText: 'x',
      reason: 'test',
      branding: { brandName: 'Radio Formosa', logoUrl: null },
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('>RF</span>');
  });

  it('el pie incluye razón social, enlaces legales y el motivo del envío', () => {
    const { html, text } = renderEmail({
      heading: 'Hola!',
      bodyHtml: '<p>x</p>',
      bodyText: 'x',
      reason: 'Te llegó este email porque creaste una cuenta.',
      branding: { frontendUrl: 'https://app.periodistapp.example' },
    });

    expect(html).toContain('Te llegó este email porque creaste una cuenta.');
    expect(html).toContain('PeriodistApp');
    expect(html).toContain('https://app.periodistapp.example/terms');
    expect(html).toContain('https://app.periodistapp.example/privacy');
    expect(text).toContain('Te llegó este email porque creaste una cuenta.');
    expect(text).toContain('https://app.periodistapp.example/terms');
  });

  it('escapa contenido controlado por el usuario (nombre/heading)', () => {
    const { html } = renderEmail({
      heading: 'Hola <script>alert(1)</script>',
      bodyHtml: '<p>x</p>',
      bodyText: 'x',
      reason: 'test',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('builders — los 10 tipos de email', () => {
  const date = new Date('2026-12-01T12:00:00Z');
  const expectedDate = date.toLocaleDateString('es-AR');

  const cases: { name: string; build: () => BuiltEmail; expects: string[] }[] = [
    {
      name: 'verification',
      build: () => buildVerificationEmail({ name: 'Ana', token: 'tok-1' }),
      expects: ['Verifica tu cuenta - PeriodistApp', 'verify-email?token=tok-1', '48 horas'],
    },
    {
      name: 'welcome',
      build: () => buildWelcomeEmail({ name: 'Ana' }),
      expects: ['Bienvenido a PeriodistApp!', '/dashboard', '5 horas de procesamiento'],
    },
    {
      name: 'passwordReset',
      build: () => buildPasswordResetEmail({ name: 'Ana', token: 'tok-2' }),
      expects: ['Resetear contrasena - PeriodistApp', 'reset-password?token=tok-2', '1 hora'],
    },
    {
      name: 'teamInvite',
      build: () => buildTeamInviteEmail({
        tenantName: 'Radio Sur',
        inviterName: 'Beto',
        role: 'viewer',
        token: 'tok-3',
        expiresInHours: 72,
      }),
      expects: ['Te invitaron a Radio Sur - PeriodistApp', 'accept-invite?token=tok-3', 'lector (solo lectura)', '72 horas'],
    },
    {
      name: 'trialEnding',
      build: () => buildTrialEndingEmail({ name: 'Ana', daysLeft: 2 }),
      expects: ['Tu prueba termina en 2 días - PeriodistApp', '/billing', '2 días'],
    },
    {
      name: 'trialEnding singular',
      build: () => buildTrialEndingEmail({ name: 'Ana', daysLeft: 1 }),
      expects: ['Tu prueba termina en 1 día - PeriodistApp', '1 día'],
    },
    {
      name: 'trialExpired',
      build: () => buildTrialExpiredEmail({ name: 'Ana' }),
      expects: ['Tu prueba terminó - PeriodistApp', '/billing', 'no podés iniciar nuevas transmisiones'],
    },
    {
      name: 'paymentSucceeded',
      build: () => buildPaymentSucceededEmail({ name: 'Ana', amount: '29.00', currency: 'USD', planDisplayName: 'Creator' }),
      expects: ['Pago recibido - PeriodistApp', '29.00 USD', 'Creator', '/billing'],
    },
    {
      name: 'paymentFailed',
      build: () => buildPaymentFailedEmail({ name: 'Ana', attempt: 2, graceEndsAt: date }),
      expects: ['No pudimos cobrar tu suscripción - PeriodistApp', 'intento', expectedDate, '/billing'],
    },
    {
      name: 'addonPurchased',
      build: () => buildAddonPurchasedEmail({ name: 'Ana', transmissions: 5, expiresAt: date }),
      expects: ['+5 transmisiones acreditadas - PeriodistApp', '5 transmisiones', expectedDate],
    },
    {
      name: 'subscriptionSuspended',
      build: () => buildSubscriptionSuspendedEmail({ name: 'Ana' }),
      expects: ['Tu suscripción fue suspendida - PeriodistApp', 'suspendida', '/billing'],
    },
  ];

  for (const c of cases) {
    it(`${c.name}: renderiza con subject y contenido esperado en html y text`, () => {
      const built = c.build();
      const [subject, ...fragments] = c.expects;
      expect(built.subject).toBe(subject);
      for (const fragment of fragments) {
        expect(built.html).toContain(fragment);
      }
    });
  }

  it('la versión text contiene los mismos datos clave (links y montos)', () => {
    const verify = buildVerificationEmail({ name: 'Ana', token: 'tok-1' });
    expect(verify.text).toContain('/verify-email?token=tok-1');
    expect(verify.text).toContain('48 horas');

    const paid = buildPaymentSucceededEmail({ name: 'Ana', amount: '29.00', currency: 'USD', planDisplayName: 'Creator' });
    expect(paid.text).toContain('29.00 USD');
    expect(paid.text).toContain('Creator');

    const failed = buildPaymentFailedEmail({ name: 'Ana', attempt: 2, graceEndsAt: date });
    expect(failed.text).toContain('intento 2');
    expect(failed.text).toContain(expectedDate);
    expect(failed.text).toContain('/billing');

    const addon = buildAddonPurchasedEmail({ name: 'Ana', transmissions: 5, expiresAt: date });
    expect(addon.text).toContain('5 transmisiones');
    expect(addon.text).toContain(expectedDate);
  });

  it('los builders aceptan branding de tenant y lo propagan al html', () => {
    const built = buildWelcomeEmail({ name: 'Ana', branding: TENANT_BRAND });
    expect(built.html).toContain('Radio Formosa');
    expect(built.html).toContain('#e11d48');
    expect(built.html).toContain('https://cdn.radioformosa.example/logo.png');
    // El subject y el contenido funcional no cambian con el branding.
    expect(built.subject).toBe('Bienvenido a PeriodistApp!');
  });

  it('los tokens viajan solo en el link (un solo uso, sin exponer secretos extra)', () => {
    const built = buildPasswordResetEmail({ name: 'Ana', token: 'secret-token' });
    expect(built.html).toContain('reset-password?token=secret-token');
    expect(built.text).toContain('reset-password?token=secret-token');
  });
});
