/**
 * billing.ts — Tipos compartidos del paywall de transmisiones (cliente).
 */

export interface QuotaInfo {
  planName: string | null;
  status: string | null;
  periodStart: string;
  periodEnd: string;
  included: number;
  addon: number;
  extra: number;
  used: number;
  remaining: number;
  percentUsed: number;
  unlimited: boolean;
  usageCycleId: string;
}

export interface QuotaUpsell {
  canBuyAddons?: boolean;
  canUpgrade?: boolean;
}

/** Error tipado del 402 QUOTA_EXCEEDED — lleva el estado de cuota para el modal. */
export class QuotaExceededError extends Error {
  readonly status = 402;
  readonly code = 'QUOTA_EXCEEDED';
  readonly quota: QuotaInfo | null;
  readonly upsell: QuotaUpsell | null;

  constructor(message: string, quota?: QuotaInfo | null, upsell?: QuotaUpsell | null) {
    super(message);
    this.name = 'QuotaExceededError';
    this.quota = quota ?? null;
    this.upsell = upsell ?? null;
  }
}

export function isQuotaExceededError(err: unknown): err is QuotaExceededError {
  return err instanceof QuotaExceededError;
}
