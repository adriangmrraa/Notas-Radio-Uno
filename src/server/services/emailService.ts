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
