import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { register, login, verifyEmail, forgotPassword, resetPassword, getMe } from '../services/authService.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../lib/errors.js';

const router = Router();

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Demasiados intentos. Intenta de nuevo en 15 minutos.' },
});

const registerSchema = z.object({
    email: z.string().email('Email invalido'),
    password: z.string().min(8, 'La contrasena debe tener al menos 8 caracteres'),
    fullName: z.string().min(2, 'El nombre debe tener al menos 2 caracteres'),
    organizationName: z.string().min(2, 'El nombre de la organizacion debe tener al menos 2 caracteres'),
});

const loginSchema = z.object({
    email: z.string().email('Email invalido'),
    password: z.string().min(1, 'Contrasena requerida'),
});

// POST /api/auth/register
router.post('/register', authLimiter, async (req: Request, res: Response) => {
    try {
        const data = registerSchema.parse(req.body);
        const result = await register(data);
        res.status(201).json(result);
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: err.issues[0].message });
            return;
        }
        if (err instanceof AppError) {
            res.status(err.statusCode).json({ error: err.message, code: err.code });
            return;
        }
        console.error('[Auth] Register error:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/auth/login
router.post('/login', authLimiter, async (req: Request, res: Response) => {
    try {
        const data = loginSchema.parse(req.body);
        const ipAddress = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'];
        const result = await login(data, ipAddress, userAgent);
        res.json(result);
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: err.issues[0].message });
            return;
        }
        if (err instanceof AppError) {
            res.status(err.statusCode).json({ error: err.message, code: err.code });
            return;
        }
        console.error('[Auth] Login error:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/auth/verify-email?token=xxx
router.get('/verify-email', async (req: Request, res: Response) => {
    try {
        const token = req.query.token as string;
        if (!token) {
            res.status(400).json({ error: 'Token requerido' });
            return;
        }
        const result = await verifyEmail(token);
        res.json(result);
    } catch (err: any) {
        if (err instanceof AppError) {
            res.status(err.statusCode).json({ error: err.message });
            return;
        }
        console.error('[Auth] Verify error:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', authLimiter, async (req: Request, res: Response) => {
    try {
        const { email } = req.body;
        if (!email) {
            res.status(400).json({ error: 'Email requerido' });
            return;
        }
        const result = await forgotPassword(email);
        res.json(result);
    } catch (err: any) {
        console.error('[Auth] Forgot password error:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req: Request, res: Response) => {
    try {
        const { token, password } = req.body;
        if (!token || !password) {
            res.status(400).json({ error: 'Token y contrasena requeridos' });
            return;
        }
        if (password.length < 8) {
            res.status(400).json({ error: 'La contrasena debe tener al menos 8 caracteres' });
            return;
        }
        const result = await resetPassword(token, password);
        res.json(result);
    } catch (err: any) {
        if (err instanceof AppError) {
            res.status(err.statusCode).json({ error: err.message });
            return;
        }
        console.error('[Auth] Reset password error:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/auth/me (protegido)
router.get('/me', requireAuth, async (req: Request, res: Response) => {
    try {
        const result = await getMe(req.auth!.userId);
        res.json(result);
    } catch (err: any) {
        if (err instanceof AppError) {
            res.status(err.statusCode).json({ error: err.message });
            return;
        }
        console.error('[Auth] GetMe error:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

export { router as authRouter };
