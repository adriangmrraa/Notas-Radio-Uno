import { db } from '../db/index.js';
import { tenants } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import type { BrandingConfig, FontFamilyId, TemplateId } from '../../shared/types.js';

// ── In-memory cache with 5-min TTL ───────────────────────────────────────────
interface CachedBranding {
  config: BrandingConfig;
  expires: number;
}

const cache = new Map<string, CachedBranding>();
const TTL = 5 * 60 * 1000;

export function invalidateBrandingCache(tenantId: string): void {
  cache.delete(tenantId);
}

export async function loadTenantBranding(tenantId: string): Promise<BrandingConfig> {
  const cached = cache.get(tenantId);
  if (cached && Date.now() < cached.expires) {
    return cached.config;
  }

  const [tenant] = await db.select({
    logoData: tenants.logoData,
    platformName: tenants.platformName,
    fontFamily: tenants.fontFamily,
    templateId: tenants.templateId,
  }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);

  const config: BrandingConfig = {
    logoBuffer: tenant?.logoData ? Buffer.from(tenant.logoData) : null,
    platformName: tenant?.platformName || process.env.PLATFORM_NAME || 'Noticias',
    fontFamily: (tenant?.fontFamily as FontFamilyId) || 'bebas_kai',
    templateId: (tenant?.templateId as TemplateId) || 'dark_gradient',
  };

  cache.set(tenantId, { config, expires: Date.now() + TTL });
  return config;
}
