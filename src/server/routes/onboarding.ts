/**
 * routes/onboarding.ts — API del wizard de onboarding (PC-10).
 *
 *   GET  /api/onboarding/status        → { completed, currentStep, canComplete, steps[], data }
 *   POST /api/onboarding/step/:stepId  → guarda un paso (channel|program|persons|channels)
 *   POST /api/onboarding/complete      → marca onboarding_completed='true' si no falta nada
 *   POST /api/onboarding/reset         → owner only: completed='false' + borra el avance
 *
 * Todas con requireAuth. Todo opera sobre req.auth!.tenantId — el tenant nunca
 * llega por body y los ids que sí llegan se validan contra el tenant (404 si
 * son ajenos). La lógica está en services/onboardingService.ts + lib/onboardingRules.ts.
 */
import { Router, type Request, type Response } from "express";

import { requireAuth } from "../middleware/auth.js";
import { requireOwner } from "../middleware/authz.js";
import { AppError } from "../lib/errors.js";
import {
  applyOnboardingStep,
  completeOnboarding,
  getOnboardingStatus,
  resetOnboarding,
} from "../services/onboardingService.js";
import { isOnboardingStepId, missingRequirements } from "../lib/onboardingRules.js";

export const onboardingRouter = Router();

/** Exige tenant activo (un platform admin sin tenant no tiene onboarding). */
function requireTenantId(req: Request, res: Response): string | null {
  const tenantId = req.auth!.tenantId;
  if (!tenantId) {
    res.status(403).json({
      error: "Tu sesión no tiene una organización activa",
      code: "NO_ACTIVE_TENANT",
    });
    return null;
  }
  return tenantId;
}

function handleError(res: Response, err: unknown, context: string): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  console.error(`[Onboarding] ${context}:`, err);
  res.status(500).json({ error: "Error interno del servidor" });
}

// ---------------------------------------------------------------------------
// GET /api/onboarding/status
// ---------------------------------------------------------------------------
onboardingRouter.get("/status", requireAuth, async (req: Request, res: Response) => {
  const tenantId = requireTenantId(req, res);
  if (!tenantId) return;
  try {
    res.json(await getOnboardingStatus(tenantId));
  } catch (err) {
    handleError(res, err, "Error en GET status");
  }
});

// ---------------------------------------------------------------------------
// POST /api/onboarding/step/:stepId — channel | program | persons | channels
// ---------------------------------------------------------------------------
onboardingRouter.post("/step/:stepId", requireAuth, async (req: Request, res: Response) => {
  const tenantId = requireTenantId(req, res);
  if (!tenantId) return;

  const { stepId } = req.params;
  if (!isOnboardingStepId(stepId)) {
    res.status(404).json({
      error: `Paso desconocido: ${stepId}. Válidos: channel, program, persons, channels`,
    });
    return;
  }

  try {
    await applyOnboardingStep(tenantId, stepId, req.body);
    res.json(await getOnboardingStatus(tenantId));
  } catch (err) {
    handleError(res, err, `Error en POST step/${stepId}`);
  }
});

// ---------------------------------------------------------------------------
// POST /api/onboarding/complete
// ---------------------------------------------------------------------------
onboardingRouter.post("/complete", requireAuth, async (req: Request, res: Response) => {
  const tenantId = requireTenantId(req, res);
  if (!tenantId) return;
  try {
    res.json(await completeOnboarding(tenantId));
  } catch (err) {
    if (err instanceof AppError && err.code === "ONBOARDING_INCOMPLETE") {
      // 400 con el detalle de qué pasos requeridos faltan
      const missing = missingRequirements(await getOnboardingStatus(tenantId));
      res.status(400).json({ error: err.message, code: err.code, missing });
      return;
    }
    handleError(res, err, "Error en POST complete");
  }
});

// ---------------------------------------------------------------------------
// POST /api/onboarding/reset — sólo owner del tenant
// ---------------------------------------------------------------------------
onboardingRouter.post("/reset", requireAuth, requireOwner, async (req: Request, res: Response) => {
  const tenantId = requireTenantId(req, res);
  if (!tenantId) return;
  try {
    res.json(await resetOnboarding(tenantId));
  } catch (err) {
    handleError(res, err, "Error en POST reset");
  }
});
