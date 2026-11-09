/**
 * admin.ts — API de super admin de plataforma (PA-06 a PA-11)
 *
 * Router entero protegido: requireAuth + requirePlatformAdmin en el `use`, así
 * ninguna ruta nueva puede quedar sin guard por olvido. Cada mutación audita.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import { requirePlatformAdmin } from '../middleware/authz.js';
import { AppError } from '../lib/errors.js';
import {
  getPlatformStats,
  listTenants,
  getTenantDetail,
  changeTenantPlan,
  extendTenantTrial,
  grantExtraTransmissions,
  setTenantSuspended,
  overrideTenantFeature,
  resetTenantFeature,
  startImpersonation,
  endImpersonation,
} from '../services/adminService.js';
import { listPlans, updatePlan } from '../services/planService.js';

export const adminRouter = Router();

// Guard único para todo el router.
adminRouter.use(requireAuth, requirePlatformAdmin);

const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas operaciones administrativas. Esperá un minuto.' },
});

function fail(res: Response, err: unknown, context: string): void {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: err.issues[0].message });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  console.error(`[Admin] ${context}:`, err);
  res.status(500).json({ error: 'Error interno del servidor' });
}

function actor(req: Request): string {
  return req.auth!.userId;
}

function requestIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
    || req.socket.remoteAddress
    || null;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

adminRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    res.json(await getPlatformStats());
  } catch (err) {
    fail(res, err, 'GET /stats');
  }
});

// ── Tenants ───────────────────────────────────────────────────────────────────

adminRouter.get('/tenants', async (req: Request, res: Response) => {
  try {
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 25);
    const status = String(req.query.status ?? 'all') as 'all' | 'active' | 'suspended' | 'trialing';
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;

    res.json(await listTenants({ search, status, page, pageSize }));
  } catch (err) {
    fail(res, err, 'GET /tenants');
  }
});

adminRouter.get('/tenants/:id', async (req: Request, res: Response) => {
  try {
    res.json(await getTenantDetail(req.params.id));
  } catch (err) {
    fail(res, err, 'GET /tenants/:id');
  }
});

// ── Acciones sobre un tenant ──────────────────────────────────────────────────

const planSchema = z.object({ planName: z.string().min(1) });
const trialSchema = z.object({ days: z.number().int().min(1).max(90) });
const quotaSchema = z.object({ count: z.number().int().min(1).max(100) });
const suspendSchema = z.object({ suspended: z.boolean(), reason: z.string().max(500).optional() });
const featureSchema = z.object({ enabled: z.boolean(), notes: z.string().max(500).nullish() });
const impersonateSchema = z.object({
  targetUserId: z.string().uuid().nullish(),
  reason: z.string().max(500).nullish(),
});

adminRouter.patch('/tenants/:id/plan', mutationLimiter, async (req: Request, res: Response) => {
  try {
    const data = planSchema.parse(req.body);
    res.json(await changeTenantPlan({ tenantId: req.params.id, planName: data.planName, actorUserId: actor(req) }));
  } catch (err) {
    fail(res, err, 'PATCH /tenants/:id/plan');
  }
});

adminRouter.post('/tenants/:id/trial/extend', mutationLimiter, async (req: Request, res: Response) => {
  try {
    const data = trialSchema.parse(req.body);
    res.json(await extendTenantTrial({ tenantId: req.params.id, days: data.days, actorUserId: actor(req) }));
  } catch (err) {
    fail(res, err, 'POST /tenants/:id/trial/extend');
  }
});

adminRouter.post('/tenants/:id/transmissions', mutationLimiter, async (req: Request, res: Response) => {
  try {
    const data = quotaSchema.parse(req.body);
    res.json(await grantExtraTransmissions({ tenantId: req.params.id, count: data.count, actorUserId: actor(req) }));
  } catch (err) {
    fail(res, err, 'POST /tenants/:id/transmissions');
  }
});

adminRouter.post('/tenants/:id/suspend', mutationLimiter, async (req: Request, res: Response) => {
  try {
    const data = suspendSchema.parse(req.body);
    await setTenantSuspended({
      tenantId: req.params.id,
      suspended: data.suspended,
      reason: data.reason,
      actorUserId: actor(req),
    });
    res.json({ success: true, suspended: data.suspended });
  } catch (err) {
    fail(res, err, 'POST /tenants/:id/suspend');
  }
});

// ── Planes (PB-03) ────────────────────────────────────────────────────────────

adminRouter.get('/plans', async (_req: Request, res: Response) => {
  try {
    res.json(await listPlans());
  } catch (err) {
    fail(res, err, 'GET /plans');
  }
});

const planPatchSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  priceUsd: z.number().nonnegative().optional(),
  priceUsdYearly: z.number().nonnegative().nullish(),
  priceArs: z.number().nonnegative().nullish(),
  priceArsYearly: z.number().nonnegative().nullish(),
  transmissionsPerCycle: z.number().int().nonnegative().nullish(),
  maxTransmissionMinutes: z.number().int().positive().nullish(),
  maxClipsPerTransmission: z.number().int().positive().nullish(),
  maxPeople: z.number().int().positive().nullish(),
  rawRetentionDays: z.number().int().positive().nullish(),
  maxTeamMembers: z.number().int().positive().optional(),
  maxStorageGb: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

adminRouter.patch('/plans/:id', mutationLimiter, async (req: Request, res: Response) => {
  try {
    const data = planPatchSchema.parse(req.body);

    // Las columnas de precio son numeric: viajan como string en drizzle.
    const patch: Parameters<typeof updatePlan>[0]['patch'] = {};
    if (data.displayName !== undefined) patch.displayName = data.displayName;
    if (data.priceUsd !== undefined) patch.priceUsd = String(data.priceUsd);
    if (data.priceUsdYearly !== undefined) patch.priceUsdYearly = data.priceUsdYearly === null ? null : String(data.priceUsdYearly);
    if (data.priceArs !== undefined) patch.priceArs = data.priceArs === null ? null : String(data.priceArs);
    if (data.priceArsYearly !== undefined) patch.priceArsYearly = data.priceArsYearly === null ? null : String(data.priceArsYearly);
    if (data.transmissionsPerCycle !== undefined) patch.transmissionsPerCycle = data.transmissionsPerCycle;
    if (data.maxTransmissionMinutes !== undefined) patch.maxTransmissionMinutes = data.maxTransmissionMinutes;
    if (data.maxClipsPerTransmission !== undefined) patch.maxClipsPerTransmission = data.maxClipsPerTransmission;
    if (data.maxPeople !== undefined) patch.maxPeople = data.maxPeople;
    if (data.rawRetentionDays !== undefined) patch.rawRetentionDays = data.rawRetentionDays;
    if (data.maxTeamMembers !== undefined) patch.maxTeamMembers = data.maxTeamMembers;
    if (data.maxStorageGb !== undefined) patch.maxStorageGb = data.maxStorageGb;
    if (data.isActive !== undefined) patch.isActive = data.isActive;
    if (data.sortOrder !== undefined) patch.sortOrder = data.sortOrder;

    res.json(await updatePlan({ planId: req.params.id, patch, actorUserId: actor(req) }));
  } catch (err) {
    fail(res, err, 'PATCH /plans/:id');
  }
});

// ── Feature flags (PA-11) ─────────────────────────────────────────────────────

adminRouter.put('/tenants/:id/features/:key', mutationLimiter, async (req: Request, res: Response) => {
  try {
    const data = featureSchema.parse(req.body);
    const state = await overrideTenantFeature({
      tenantId: req.params.id,
      featureKey: req.params.key,
      enabled: data.enabled,
      notes: data.notes ?? null,
      actorUserId: actor(req),
    });
    res.json(state);
  } catch (err) {
    fail(res, err, 'PUT /tenants/:id/features/:key');
  }
});

adminRouter.delete('/tenants/:id/features/:key', mutationLimiter, async (req: Request, res: Response) => {
  try {
    const state = await resetTenantFeature({
      tenantId: req.params.id,
      featureKey: req.params.key,
      actorUserId: actor(req),
    });
    res.json(state);
  } catch (err) {
    fail(res, err, 'DELETE /tenants/:id/features/:key');
  }
});

// ── Impersonación (PA-10) ────────────────────────────────────────────────────

adminRouter.post('/tenants/:id/impersonate', mutationLimiter, async (req: Request, res: Response) => {
  try {
    const data = impersonateSchema.parse(req.body);
    const result = await startImpersonation({
      tenantId: req.params.id,
      targetUserId: data.targetUserId ?? null,
      reason: data.reason ?? null,
      actorUserId: actor(req),
      ipAddress: requestIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    res.status(201).json(result);
  } catch (err) {
    fail(res, err, 'POST /tenants/:id/impersonate');
  }
});

adminRouter.post('/impersonation/:sessionId/end', mutationLimiter, async (req: Request, res: Response) => {
  try {
    await endImpersonation({ sessionId: req.params.sessionId, actorUserId: actor(req) });
    res.json({ success: true });
  } catch (err) {
    fail(res, err, 'POST /impersonation/:sessionId/end');
  }
});
