/**
 * memoryDemoStore — implementación en memoria de `DemoStore` para los
 * tests del dataset demo (PI-06). Sin DB: reproduce los MISMOS filtros
 * que la implementación drizzle:
 *
 *   - `listMemberships`/`listPrograms`/`listTransmissions` son
 *     TENANT-SCOPED: `WHERE tenant_id = :tenantId` — un recurso de otro
 *     tenant nunca aparece.
 *   - `findTenantBySlug`/`findUserByEmail`/`findProgramBySlug` son lookups
 *     globales por clave UNIQUE (excepciones documentadas de idempotencia).
 *   - `claimTenantOwner` es `UPDATE ... WHERE id AND owner_id IS NULL`.
 *
 * `now` inyectable: los defaults de columna (created_at/updated_at) usan
 * el reloj inyectado — tests deterministas con un `T0` fijo.
 */
import type {
  DemoMembership,
  DemoProgram,
  DemoStore,
  DemoTenant,
  DemoTransmission,
  DemoUser,
} from '../../src/server/services/demoDataService';
import type { UserRole } from '../../src/server/db/schema/enums.js';

export interface MemoryDemoState {
  tenants: DemoTenant[];
  users: DemoUser[];
  memberships: DemoMembership[];
  programs: DemoProgram[];
  transmissions: DemoTransmission[];
}

let seq = 0;
const nextId = () =>
  `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

export function createMemoryDemoStore(opts?: {
  now?: () => Date;
}): { store: DemoStore; state: MemoryDemoState } {
  const now = opts?.now ?? (() => new Date());
  const state: MemoryDemoState = {
    tenants: [],
    users: [],
    memberships: [],
    programs: [],
    transmissions: [],
  };

  const store: DemoStore = {
    async findTenantBySlug(slug) {
      return state.tenants.find((t) => t.slug === slug) ?? null;
    },

    async insertTenant(v) {
      const t = now();
      const row: DemoTenant = {
        id: nextId(),
        name: v.name,
        slug: v.slug,
        ownerId: null,
        platformName: v.platformName,
        logoUrl: null,
        logoData: null,
        logoMimeType: null,
        fontFamily: 'bebas_kai',
        templateId: 'dark_gradient',
        timezone: 'America/Argentina/Buenos_Aires',
        config: {},
        isActive: true,
        createdAt: t,
        updatedAt: t,
      };
      state.tenants.push(row);
      return row;
    },

    async claimTenantOwner(tenantId, ownerId) {
      // Mismo WHERE que el drizzle: sólo si owner_id sigue NULL.
      const t = state.tenants.find((x) => x.id === tenantId);
      if (t && t.ownerId === null) t.ownerId = ownerId;
    },

    async findUserByEmail(email) {
      return state.users.find((u) => u.email === email) ?? null;
    },

    async insertUser(v) {
      const t = now();
      const row: DemoUser = {
        id: nextId(),
        email: v.email,
        passwordHash: v.passwordHash,
        fullName: v.fullName,
        avatarUrl: null,
        tenantId: v.tenantId,
        role: v.role,
        status: 'active',
        isVerified: true,
        isPlatformAdmin: false,
        verificationToken: null,
        verificationTokenExpiresAt: null,
        resetPasswordToken: null,
        resetPasswordExpiresAt: null,
        lastLoginAt: null,
        createdAt: t,
        updatedAt: t,
      };
      state.users.push(row);
      return row;
    },

    async findMembership(userId, tenantId) {
      return (
        state.memberships.find(
          (m) => m.userId === userId && m.tenantId === tenantId,
        ) ?? null
      );
    },

    async insertMembership(v) {
      const t = now();
      const row: DemoMembership = {
        userId: v.userId,
        tenantId: v.tenantId,
        role: v.role,
        status: 'active',
        lastUsedAt: null,
        createdAt: t,
        updatedAt: t,
      };
      state.memberships.push(row);
      return row;
    },

    // Tenant-scoped igual que el drizzle: WHERE tenant_id = :tenantId.
    async listMemberships(tenantId) {
      return state.memberships.filter((m) => m.tenantId === tenantId);
    },

    async findProgramBySlug(slug) {
      return state.programs.find((p) => p.slug === slug) ?? null;
    },

    async insertProgram(v) {
      const t = now();
      const row: DemoProgram = {
        id: nextId(),
        tenantId: v.tenantId,
        name: v.name,
        description: v.description,
        schedule: v.schedule,
        slug: v.slug,
        isPublic: false,
        isActive: true,
        createdAt: t,
        updatedAt: t,
      };
      state.programs.push(row);
      return row;
    },

    // Tenant-scoped igual que el drizzle: WHERE tenant_id = :tenantId.
    async listPrograms(tenantId) {
      return state.programs.filter((p) => p.tenantId === tenantId);
    },

    // Tenant-scoped igual que el drizzle: WHERE tenant_id = :tenantId.
    async listTransmissions(tenantId) {
      return state.transmissions.filter((x) => x.tenantId === tenantId);
    },

    async insertTransmission(v) {
      const t = now();
      const row: DemoTransmission = {
        id: nextId(),
        tenantId: v.tenantId,
        programId: v.programId,
        scheduledTransmissionId: null,
        source: v.source,
        status: v.status,
        streamUrl: null,
        resolvedStreamUrl: null,
        crudoRef: null,
        durationMinutes: v.durationMinutes,
        startedAt: null,
        endedAt: null,
        waitingSince: null,
        lastHeartbeatAt: null,
        errorMessage: null,
        pipelineConfig: { demoKey: v.demoKey },
        createdAt: t,
        updatedAt: t,
      };
      state.transmissions.push(row);
      return row;
    },
  };

  return { store, state };
}
