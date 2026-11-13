/**
 * demoDataService.ts — dataset DEMO multi-tenant (PI-06).
 *
 * Siembra un entorno de demostración coherente con el modelo del producto:
 *
 *   tenant            ↔ la org/medio (tenants)
 *   sedes/secciones   ↔ programs del tenant
 *   membresías        ↔ user_tenants (owner/editor/viewer)
 *   contenido mínimo  ↔ transmissions demo (marca pipelineConfig.demoKey)
 *
 * Todo el contenido es claramente demo (slugs `demo-*`, dominio `.test`,
 * nombres marcados "(demo)"): nada se presenta como dato real.
 *
 * REGLA tenant_id — el seed nunca lee ni escribe datos de OTRO tenant:
 *   - Toda lectura de contenido filtra por `tenant_id`
 *     (listPrograms/listTransmissions/listMemberships).
 *   - Toda escritura inserta con el `tenantId` del tenant sembrado.
 *   - Únicas lecturas globales (excepciones documentadas, necesarias para
 *     idempotencia): `findTenantBySlug` y `findUserByEmail` usan las claves
 *     UNIQUE de `tenants.slug`/`users.email`, y `findProgramBySlug` la de
 *     `programs.slug` — no leen contenido de otro tenant, sólo resuelven
 *     "¿ya existe ESTA entidad semilla?".
 *
 * Idempotente: cada entidad tiene clave natural (slug, email,
 * (userId,tenantId), pipelineConfig.demoKey). Re-run = 0 insertados.
 *
 * Patrón store del repo: `DemoStore` + `createDrizzleDemoStore(db)` +
 * memory store en tests/helpers. `seedDemoData(store)` no conoce drizzle.
 */
import bcrypt from 'bcryptjs';
import { and, eq, isNull } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import {
  programs,
  tenants,
  transmissions,
  userTenants,
  users,
} from '../db/schema/index.js';
import type { UserRole } from '../db/schema/enums.js';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type DemoTenant = typeof tenants.$inferSelect;
export type DemoUser = typeof users.$inferSelect;
export type DemoMembership = typeof userTenants.$inferSelect;
export type DemoProgram = typeof programs.$inferSelect;
export type DemoTransmission = typeof transmissions.$inferSelect;

interface DemoUserSpec {
  email: string;
  fullName: string;
  role: UserRole;
}

interface DemoProgramSpec {
  slug: string;
  name: string;
  description: string;
  schedule: string;
}

interface DemoTransmissionSpec {
  /** Clave idempotente dentro de pipelineConfig.demoKey. */
  demoKey: string;
  programSlug: string;
  source: 'live_capture' | 'vod_upload' | 'manual';
  status: 'scheduled' | 'done';
  durationMinutes: number;
}

interface DemoTenantSpec {
  slug: string;
  name: string;
  platformName: string;
  users: DemoUserSpec[];
  programs: DemoProgramSpec[];
  transmissions: DemoTransmissionSpec[];
}

export interface DemoSeedSummary {
  tenants: { inserted: string[]; reused: string[] };
  users: { inserted: string[]; reused: string[] };
  memberships: { inserted: string[]; reused: string[] };
  programs: { inserted: string[]; reused: string[] };
  transmissions: { inserted: string[]; reused: string[] };
}

// ---------------------------------------------------------------------------
// Dataset demo — dos medios ficticios, suficiente para probar aislamiento
// ---------------------------------------------------------------------------

export const DEMO_SEED: readonly DemoTenantSpec[] = [
  {
    slug: 'demo-radio-norte',
    name: 'Radio Norte (demo)',
    platformName: 'Radio Norte',
    users: [
      {
        email: 'owner@demo-radio-norte.test',
        fullName: 'Ana Duarte (demo)',
        role: 'owner',
      },
      {
        email: 'editor@demo-radio-norte.test',
        fullName: 'Luis Mora (demo)',
        role: 'editor',
      },
    ],
    programs: [
      {
        slug: 'demo-radio-norte-morning',
        name: 'Mañana Norte (demo)',
        description: 'Magazine informativo de la mañana — contenido demo.',
        schedule: 'Lun–Vie 07:00–10:00',
      },
      {
        slug: 'demo-radio-norte-evening',
        name: 'Norte al Cierre (demo)',
        description: 'Informativo central de la tarde — contenido demo.',
        schedule: 'Lun–Vie 18:00–19:00',
      },
    ],
    transmissions: [
      {
        demoKey: 'demo-radio-norte-ep-001',
        programSlug: 'demo-radio-norte-morning',
        source: 'vod_upload',
        status: 'done',
        durationMinutes: 95,
      },
    ],
  },
  {
    slug: 'demo-canal-sur',
    name: 'Canal Sur (demo)',
    platformName: 'Canal Sur',
    users: [
      {
        email: 'owner@demo-canal-sur.test',
        fullName: 'Marta Ruiz (demo)',
        role: 'owner',
      },
      {
        email: 'viewer@demo-canal-sur.test',
        fullName: 'Pablo Vera (demo)',
        role: 'viewer',
      },
    ],
    programs: [
      {
        slug: 'demo-canal-sur-central',
        name: 'Sur Central (demo)',
        description: 'Programa central del canal — contenido demo.',
        schedule: 'Lun–Vie 20:00–21:00',
      },
    ],
    transmissions: [
      {
        demoKey: 'demo-canal-sur-ep-001',
        programSlug: 'demo-canal-sur-central',
        source: 'manual',
        status: 'done',
        durationMinutes: 60,
      },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface DemoStore {
  /** Lookup por clave única tenants.slug (excepción documentada: idempotencia). */
  findTenantBySlug(slug: string): Promise<DemoTenant | null>;
  insertTenant(v: {
    slug: string;
    name: string;
    platformName: string;
  }): Promise<DemoTenant>;
  /** Marca el owner si la columna está NULL (tenant-scoped por id). */
  claimTenantOwner(tenantId: string, ownerId: string): Promise<void>;

  /** Lookup por clave única users.email (excepción documentada: idempotencia). */
  findUserByEmail(email: string): Promise<DemoUser | null>;
  insertUser(v: {
    email: string;
    fullName: string;
    passwordHash: string;
    tenantId: string;
    role: UserRole;
  }): Promise<DemoUser>;

  findMembership(userId: string, tenantId: string): Promise<DemoMembership | null>;
  insertMembership(v: {
    userId: string;
    tenantId: string;
    role: UserRole;
  }): Promise<DemoMembership>;
  /** Tenant-scoped: sólo membresías del tenant pedido. */
  listMemberships(tenantId: string): Promise<DemoMembership[]>;

  /** Lookup por clave única programs.slug (excepción documentada: idempotencia). */
  findProgramBySlug(slug: string): Promise<DemoProgram | null>;
  insertProgram(v: {
    tenantId: string;
    slug: string;
    name: string;
    description: string;
    schedule: string;
  }): Promise<DemoProgram>;
  /** Tenant-scoped: sólo programas del tenant pedido. */
  listPrograms(tenantId: string): Promise<DemoProgram[]>;

  /** Tenant-scoped: sólo transmisiones del tenant pedido. */
  listTransmissions(tenantId: string): Promise<DemoTransmission[]>;
  insertTransmission(v: {
    tenantId: string;
    programId: string;
    source: DemoTransmissionSpec['source'];
    status: DemoTransmissionSpec['status'];
    durationMinutes: number;
    demoKey: string;
  }): Promise<DemoTransmission>;
}

// ---------------------------------------------------------------------------
// Implementación drizzle (todas las lecturas de contenido filtran tenant_id)
// ---------------------------------------------------------------------------

export function createDrizzleDemoStore(database: Database = db): DemoStore {
  return {
    async findTenantBySlug(slug) {
      const [row] = await database
        .select()
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .limit(1);
      return row ?? null;
    },

    async insertTenant(v) {
      const [row] = await database.insert(tenants).values(v).returning();
      return row;
    },

    async claimTenantOwner(tenantId, ownerId) {
      await database
        .update(tenants)
        .set({ ownerId })
        .where(and(eq(tenants.id, tenantId), isNull(tenants.ownerId)));
    },

    async findUserByEmail(email) {
      const [row] = await database
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      return row ?? null;
    },

    async insertUser(v) {
      const [row] = await database
        .insert(users)
        .values({ ...v, status: 'active', isVerified: true })
        .returning();
      return row;
    },

    async findMembership(userId, tenantId) {
      const [row] = await database
        .select()
        .from(userTenants)
        .where(
          and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)),
        )
        .limit(1);
      return row ?? null;
    },

    async insertMembership(v) {
      const [row] = await database
        .insert(userTenants)
        .values({ ...v, status: 'active' })
        .returning();
      return row;
    },

    async listMemberships(tenantId) {
      return database
        .select()
        .from(userTenants)
        .where(eq(userTenants.tenantId, tenantId));
    },

    async findProgramBySlug(slug) {
      const [row] = await database
        .select()
        .from(programs)
        .where(eq(programs.slug, slug))
        .limit(1);
      return row ?? null;
    },

    async insertProgram(v) {
      const [row] = await database.insert(programs).values(v).returning();
      return row;
    },

    async listPrograms(tenantId) {
      return database
        .select()
        .from(programs)
        .where(eq(programs.tenantId, tenantId));
    },

    async listTransmissions(tenantId) {
      return database
        .select()
        .from(transmissions)
        .where(eq(transmissions.tenantId, tenantId));
    },

    async insertTransmission(v) {
      const { demoKey, ...rest } = v;
      const [row] = await database
        .insert(transmissions)
        .values({ ...rest, pipelineConfig: { demoKey } })
        .returning();
      return row;
    },
  };
}

// ---------------------------------------------------------------------------
// Seed (puro sobre el store — idempotente por claves naturales)
// ---------------------------------------------------------------------------

const demoKeyOf = (t: DemoTransmission): string | null => {
  const cfg = t.pipelineConfig;
  if (cfg && typeof cfg === 'object' && 'demoKey' in cfg) {
    const k = (cfg as Record<string, unknown>).demoKey;
    return typeof k === 'string' ? k : null;
  }
  return null;
};

export async function seedDemoData(
  store: DemoStore,
  opts?: {
    /**
     * Password en claro que se hashea para las cuentas demo NUEVAS (las
     * existentes no se tocan). Si no se pasa, se genera una aleatoria
     * irrecuperable — las cuentas quedan inaccesibles hasta un reset.
     */
    demoPassword?: string;
    /** Hasheador inyectable (tests: fake determinista). */
    hashPassword?: (plain: string) => string;
  },
): Promise<DemoSeedSummary> {
  const hash =
    opts?.hashPassword ?? ((plain: string) => bcrypt.hashSync(plain, 10));
  const summary: DemoSeedSummary = {
    tenants: { inserted: [], reused: [] },
    users: { inserted: [], reused: [] },
    memberships: { inserted: [], reused: [] },
    programs: { inserted: [], reused: [] },
    transmissions: { inserted: [], reused: [] },
  };

  for (const spec of DEMO_SEED) {
    let tenant = await store.findTenantBySlug(spec.slug);
    if (!tenant) {
      tenant = await store.insertTenant({
        slug: spec.slug,
        name: spec.name,
        platformName: spec.platformName,
      });
      summary.tenants.inserted.push(spec.slug);
    } else {
      summary.tenants.reused.push(spec.slug);
    }

    let ownerUser: DemoUser | null = null;
    for (const u of spec.users) {
      let user = await store.findUserByEmail(u.email);
      if (!user) {
        const plain = opts?.demoPassword ?? crypto.randomUUID();
        user = await store.insertUser({
          email: u.email,
          fullName: u.fullName,
          passwordHash: hash(plain),
          tenantId: tenant.id,
          role: u.role,
        });
        summary.users.inserted.push(u.email);
      } else {
        summary.users.reused.push(u.email);
      }
      if (u.role === 'owner') ownerUser = user;

      const membership = await store.findMembership(user.id, tenant.id);
      if (!membership) {
        await store.insertMembership({
          userId: user.id,
          tenantId: tenant.id,
          role: u.role,
        });
        summary.memberships.inserted.push(u.email);
      } else {
        summary.memberships.reused.push(u.email);
      }
    }

    if (ownerUser) {
      await store.claimTenantOwner(tenant.id, ownerUser.id);
    }

    const programBySlug = new Map<string, DemoProgram>();
    for (const p of spec.programs) {
      let program = await store.findProgramBySlug(p.slug);
      if (!program) {
        program = await store.insertProgram({
          tenantId: tenant.id,
          slug: p.slug,
          name: p.name,
          description: p.description,
          schedule: p.schedule,
        });
        summary.programs.inserted.push(p.slug);
      } else {
        summary.programs.reused.push(p.slug);
      }
      programBySlug.set(p.slug, program);
    }

    const existingTransmissions = await store.listTransmissions(tenant.id);
    for (const t of spec.transmissions) {
      if (existingTransmissions.some((x) => demoKeyOf(x) === t.demoKey)) {
        summary.transmissions.reused.push(t.demoKey);
        continue;
      }
      const program = programBySlug.get(t.programSlug);
      if (!program) continue;
      await store.insertTransmission({
        tenantId: tenant.id,
        programId: program.id,
        source: t.source,
        status: t.status,
        durationMinutes: t.durationMinutes,
        demoKey: t.demoKey,
      });
      summary.transmissions.inserted.push(t.demoKey);
    }
  }

  return summary;
}
