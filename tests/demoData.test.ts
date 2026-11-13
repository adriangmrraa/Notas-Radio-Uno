/**
 * Tests del slice PI-06: dataset demo multi-tenant (`demoDataService` +
 * `scripts/seed-demo.ts`).
 *
 * Deterministas: memory store con los MISMOS filtros por tenant que el
 * drizzle (tests/helpers/memoryDemoStore.ts), hash inyectado, sin DB,
 * sin bcrypt real, sin env.
 *
 * Casos obligatorios del brief:
 *   1) seed crea tenant demo + org + sedes (programs) + membresías
 *      (user_tenants) + contenido mínimo (transmissions).
 *   2) IDEMPOTENTE: segundo run inserta 0 filas (reusa todo por claves
 *      naturales: slug, email, (userId,tenantId), pipelineConfig.demoKey).
 *   3) AISLAMIENTO: las lecturas tenant-scoped del tenant A nunca
 *      devuelven datos del tenant B (programs, transmissions,
 *      memberships).
 *   4) owner del tenant queda asignado via claimTenantOwner.
 *   5) ningún seed toca una membresía/programa/transmission de otro
 *      tenant: escribir en B no altera las lecturas de A.
 */
import { describe, expect, it } from 'vitest';

import { seedDemoData, DEMO_SEED } from '../src/server/services/demoDataService';
import { createMemoryDemoStore } from './helpers/memoryDemoStore';

const T0 = new Date('2026-11-13T12:00:00.000Z');
const fakeHash = (plain: string) => `hash:${plain}`;

const seed = () =>
  seedDemoData(createMemoryDemoStore({ now: () => T0 }).store, {
    demoPassword: 'demo-pass',
    hashPassword: fakeHash,
  });

describe('seedDemoData — dataset demo multi-tenant', () => {
    it('(1) crea tenants + orgs + sedes + membresías + contenido mínimo', async () => {
        const { store, state } = createMemoryDemoStore({ now: () => T0 });
        const summary = await seedDemoData(store, {
            demoPassword: 'demo-pass',
            hashPassword: fakeHash,
        });

        expect(summary.tenants.inserted).toEqual(
            DEMO_SEED.map((t) => t.slug),
        );
        // 2 usuarios por tenant del spec.
        expect(summary.users.inserted).toHaveLength(4);
        expect(summary.memberships.inserted).toHaveLength(4);
        expect(summary.programs.inserted).toHaveLength(3);
        expect(summary.transmissions.inserted).toHaveLength(2);

        // Membresías: rol efectivo por tenant (owner/editor/viewer).
        const roles = state.memberships.map((m) => m.role).sort();
        expect(roles).toEqual(['editor', 'owner', 'owner', 'viewer']);

        // Las cuentas demo quedan activas/verificadas y con hash del
        // hasher inyectado (nunca la password en claro).
        for (const u of state.users) {
            expect(u.status).toBe('active');
            expect(u.isVerified).toBe(true);
            expect(u.passwordHash).toBe('hash:demo-pass');
            expect(u.passwordHash).not.toBe('demo-pass');
        }
    });

    it('(2) es idempotente: segundo run inserta 0 y reusa todo', async () => {
        const { store, state } = createMemoryDemoStore({ now: () => T0 });
        await seedDemoData(store, {
            demoPassword: 'demo-pass',
            hashPassword: fakeHash,
        });
        const counts = {
            tenants: state.tenants.length,
            users: state.users.length,
            memberships: state.memberships.length,
            programs: state.programs.length,
            transmissions: state.transmissions.length,
        };

        const second = await seedDemoData(store, {
            demoPassword: 'demo-pass',
            hashPassword: fakeHash,
        });

        expect(second.tenants.inserted).toHaveLength(0);
        expect(second.users.inserted).toHaveLength(0);
        expect(second.memberships.inserted).toHaveLength(0);
        expect(second.programs.inserted).toHaveLength(0);
        expect(second.transmissions.inserted).toHaveLength(0);
        expect(second.tenants.reused).toEqual(DEMO_SEED.map((t) => t.slug));

        // Nada se duplicó.
        expect(state.tenants).toHaveLength(counts.tenants);
        expect(state.users).toHaveLength(counts.users);
        expect(state.memberships).toHaveLength(counts.memberships);
        expect(state.programs).toHaveLength(counts.programs);
        expect(state.transmissions).toHaveLength(counts.transmissions);
    });

    it('(3) aislamiento: las lecturas tenant-scoped de A nunca ven a B', async () => {
        const { store, state } = createMemoryDemoStore({ now: () => T0 });
        await seedDemoData(store, {
            demoPassword: 'demo-pass',
            hashPassword: fakeHash,
        });

        const [tenantA, tenantB] = state.tenants;
        expect(tenantA.slug).toBe('demo-radio-norte');
        expect(tenantB.slug).toBe('demo-canal-sur');

        // Programs de A: todos de A, ninguno de B.
        const programsA = await store.listPrograms(tenantA.id);
        expect(programsA.length).toBe(2);
        expect(programsA.every((p) => p.tenantId === tenantA.id)).toBe(true);
        expect(programsA.some((p) => p.slug === 'demo-canal-sur-central')).toBe(
            false,
        );

        // Transmissions de B: B ve la suya, A no la ve.
        const transmissionsB = await store.listTransmissions(tenantB.id);
        expect(transmissionsB).toHaveLength(1);
        expect(transmissionsB[0].tenantId).toBe(tenantB.id);
        const transmissionsA = await store.listTransmissions(tenantA.id);
        expect(transmissionsA).toHaveLength(1);
        expect(transmissionsA[0].id).not.toBe(transmissionsB[0].id);

        // Membresías: A no ve los miembros de B.
        const membershipsA = await store.listMemberships(tenantA.id);
        const membershipsB = await store.listMemberships(tenantB.id);
        expect(membershipsA).toHaveLength(2);
        expect(membershipsB).toHaveLength(2);
        const userIdsB = new Set(membershipsB.map((m) => m.userId));
        expect(membershipsA.some((m) => userIdsB.has(m.userId))).toBe(false);
    });

    it('(4) el owner queda asignado al tenant (claimTenantOwner)', async () => {
        const { store, state } = createMemoryDemoStore({ now: () => T0 });
        await seedDemoData(store, {
            demoPassword: 'demo-pass',
            hashPassword: fakeHash,
        });
        const [tenantA, tenantB] = state.tenants;
        const ownerA = state.users.find((u) => u.email === 'owner@demo-radio-norte.test')!;
        const ownerB = state.users.find((u) => u.email === 'owner@demo-canal-sur.test')!;
        expect(tenantA.ownerId).toBe(ownerA.id);
        expect(tenantB.ownerId).toBe(ownerB.id);
    });

    it('(5) escribir contenido en B no altera las lecturas de A', async () => {
        const { store, state } = createMemoryDemoStore({ now: () => T0 });
        await seedDemoData(store, {
            demoPassword: 'demo-pass',
            hashPassword: fakeHash,
        });
        const [tenantA, tenantB] = state.tenants;

        const before = await store.listPrograms(tenantA.id);
        await store.insertProgram({
            tenantId: tenantB.id,
            slug: 'demo-canal-sur-extra',
            name: 'Extra Sur (demo)',
            description: 'x',
            schedule: 'x',
        });
        const after = await store.listPrograms(tenantA.id);
        expect(after.map((p) => p.id)).toEqual(before.map((p) => p.id));

        // Una transmission de B con programa de B tampoco aparece en A.
        const programB = await store.listPrograms(tenantB.id);
        await store.insertTransmission({
            tenantId: tenantB.id,
            programId: programB[0].id,
            source: 'manual',
            status: 'done',
            durationMinutes: 10,
            demoKey: 'demo-canal-sur-extra-ep',
        });
        const transA = await store.listTransmissions(tenantA.id);
        expect(transA.every((t) => t.tenantId === tenantA.id)).toBe(true);
        expect(transA).toHaveLength(1);
    });
});
