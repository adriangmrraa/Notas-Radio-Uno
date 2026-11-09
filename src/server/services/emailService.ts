import nodemailer from 'nodemailer';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
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

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
    if (!process.env.SMTP_HOST) {
        console.log(`[Email] SMTP no configurado. Email a ${to}: ${subject}`);
        return;
    }

    await transporter.sendMail({
        from: SMTP_FROM,
        to,
        subject,
        html,
    });
}

export async function sendVerificationEmail(email: string, name: string, token: string): Promise<void> {
    const url = `${FRONTEND_URL}/verify-email?token=${token}`;
    await sendEmail(email, 'Verifica tu cuenta - PeriodistApp', `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Hola ${name}!</h2>
            <p>Gracias por registrarte en PeriodistApp. Para activar tu cuenta, haz clic en el siguiente enlace:</p>
            <p style="text-align: center; margin: 30px 0;">
                <a href="${url}" style="background: #6366f1; color: white; padding: 12px 32px; text-decoration: none; border-radius: 8px; font-weight: bold;">
                    Verificar mi email
                </a>
            </p>
            <p style="color: #666; font-size: 14px;">Este enlace expira en 48 horas.</p>
            <p style="color: #666; font-size: 14px;">Si no creaste esta cuenta, ignora este email.</p>
        </div>
    `);
}

export async function sendWelcomeEmail(email: string, name: string): Promise<void> {
    await sendEmail(email, 'Bienvenido a PeriodistApp!', `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Bienvenido ${name}!</h2>
            <p>Tu cuenta ha sido verificada exitosamente. Ya puedes comenzar a usar PeriodistApp.</p>
            <p>Tu periodo de prueba gratuito de 7 dias ha comenzado. Durante este tiempo tendras acceso a:</p>
            <ul>
                <li>5 horas de procesamiento de pipeline</li>
                <li>20 publicaciones</li>
                <li>2 agentes custom</li>
                <li>Generacion de imagenes con IA</li>
            </ul>
            <p style="text-align: center; margin: 30px 0;">
                <a href="${FRONTEND_URL}/dashboard" style="background: #6366f1; color: white; padding: 12px 32px; text-decoration: none; border-radius: 8px; font-weight: bold;">
                    Ir al Dashboard
                </a>
            </p>
        </div>
    `);
}

export async function sendPasswordResetEmail(email: string, name: string, token: string): Promise<void> {
    const url = `${FRONTEND_URL}/reset-password?token=${token}`;
    await sendEmail(email, 'Resetear contrasena - PeriodistApp', `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Hola ${name}</h2>
            <p>Recibimos una solicitud para resetear tu contrasena. Haz clic en el siguiente enlace:</p>
            <p style="text-align: center; margin: 30px 0;">
                <a href="${url}" style="background: #6366f1; color: white; padding: 12px 32px; text-decoration: none; border-radius: 8px; font-weight: bold;">
                    Resetear contrasena
                </a>
            </p>
            <p style="color: #666; font-size: 14px;">Este enlace expira en 1 hora.</p>
            <p style="color: #666; font-size: 14px;">Si no solicitaste esto, ignora este email.</p>
        </div>
    `);
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
    },
): Promise<void> {
    const url = `${FRONTEND_URL}/accept-invite?token=${opts.token}`;
    const roleLabel = opts.role === 'viewer' ? 'lector (solo lectura)' : 'editor';

    await sendEmail(email, `Te invitaron a ${opts.tenantName} - PeriodistApp`, `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Hola!</h2>
            <p><strong>${opts.inviterName}</strong> te invitó a sumarte al equipo de
            <strong>${opts.tenantName}</strong> en PeriodistApp como <strong>${roleLabel}</strong>.</p>
            <p style="text-align: center; margin: 30px 0;">
                <a href="${url}" style="background: #6366f1; color: white; padding: 12px 32px; text-decoration: none; border-radius: 8px; font-weight: bold;">
                    Aceptar invitación
                </a>
            </p>
            <p style="color: #666; font-size: 14px;">Este enlace expira en ${opts.expiresInHours} horas.</p>
            <p style="color: #666; font-size: 14px;">Si no esperabas esta invitación, ignorá este email.</p>
        </div>
    `);
}

// ── Emails del ciclo de vida de suscripción (Épica B) ─────────────────────────
// Todos pasan por sendEmail: sin SMTP configurado son no-op (log local).

export async function sendTrialEndingEmail(email: string, name: string, daysLeft: number): Promise<void> {
    await sendEmail(email, `Tu prueba termina en ${daysLeft} ${daysLeft === 1 ? 'día' : 'días'} - PeriodistApp`, `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Hola ${name}!</h2>
            <p>Tu período de prueba en PeriodistApp termina en <strong>${daysLeft} ${daysLeft === 1 ? 'día' : 'días'}</strong>.</p>
            <p>Para seguir transmitiendo sin interrupciones, elegí un plan que se ajuste a tu operación.</p>
            <p style="text-align: center; margin: 30px 0;">
                <a href="${FRONTEND_URL}/billing" style="background: #6366f1; color: white; padding: 12px 32px; text-decoration: none; border-radius: 8px; font-weight: bold;">
                    Elegir un plan
                </a>
            </p>
        </div>
    `);
}

export async function sendTrialExpiredEmail(email: string, name: string): Promise<void> {
    await sendEmail(email, 'Tu prueba terminó - PeriodistApp', `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Hola ${name}</h2>
            <p>Tu período de prueba en PeriodistApp terminó. Tus notas, clips e historial siguen disponibles,
            pero ya no podés iniciar nuevas transmisiones.</p>
            <p>Elegí un plan para volver a transmitir.</p>
            <p style="text-align: center; margin: 30px 0;">
                <a href="${FRONTEND_URL}/billing" style="background: #6366f1; color: white; padding: 12px 32px; text-decoration: none; border-radius: 8px; font-weight: bold;">
                    Ver planes
                </a>
            </p>
        </div>
    `);
}

export async function sendPaymentSucceededEmail(
    email: string,
    name: string,
    amount: number | string,
    currency: string,
    planDisplayName: string,
): Promise<void> {
    await sendEmail(email, 'Pago recibido - PeriodistApp', `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Gracias ${name}!</h2>
            <p>Recibimos tu pago de <strong>${amount} ${currency}</strong> por el plan <strong>${planDisplayName}</strong>.</p>
            <p>Tu suscripción está activa y tu cuota de transmisiones ya está disponible.</p>
            <p style="text-align: center; margin: 30px 0;">
                <a href="${FRONTEND_URL}/billing" style="background: #6366f1; color: white; padding: 12px 32px; text-decoration: none; border-radius: 8px; font-weight: bold;">
                    Ver mi facturación
                </a>
            </p>
        </div>
    `);
}

export async function sendPaymentFailedEmail(
    email: string,
    name: string,
    attempt: number,
    graceEndsAt: Date,
): Promise<void> {
    const date = graceEndsAt.toLocaleDateString('es-AR');
    await sendEmail(email, 'No pudimos cobrar tu suscripción - PeriodistApp', `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Hola ${name}</h2>
            <p>No pudimos procesar el pago de tu suscripción (intento <strong>${attempt}</strong>).</p>
            <p>Tu servicio sigue activo hasta el <strong>${date}</strong>. Después de esa fecha la cuenta se suspende.</p>
            <p>Actualizá tu medio de pago para evitar la suspensión.</p>
            <p style="text-align: center; margin: 30px 0;">
                <a href="${FRONTEND_URL}/billing" style="background: #6366f1; color: white; padding: 12px 32px; text-decoration: none; border-radius: 8px; font-weight: bold;">
                    Actualizar medio de pago
                </a>
            </p>
        </div>
    `);
}

export async function sendSubscriptionSuspendedEmail(email: string, name: string): Promise<void> {
    await sendEmail(email, 'Tu suscripción fue suspendida - PeriodistApp', `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Hola ${name}</h2>
            <p>Tu suscripción de PeriodistApp quedó <strong>suspendida</strong> por falta de pago.</p>
            <p>Tus notas, clips e historial se conservan. Para volver a transmitir, regularizá el pago.</p>
            <p style="text-align: center; margin: 30px 0;">
                <a href="${FRONTEND_URL}/billing" style="background: #6366f1; color: white; padding: 12px 32px; text-decoration: none; border-radius: 8px; font-weight: bold;">
                    Regularizar pago
                </a>
            </p>
        </div>
    `);
}
