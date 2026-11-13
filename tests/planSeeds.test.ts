/**
 * Tests del slice PI-06: idempotencia de los seeds de catálogo
 * (`seedPlans()`/`seedAddons()` usados por scripts/seed-plans.ts y por el
 * boot del server).
 *
 * Deterministas: `db` reemplazado por un fake en memoria que reproduce la
 * semántica de las queries drizzle usadas por los seeds (select+where+limit,
 * insert+values+onConflictDoNothing, update+set+where). `eq` se mockea a un
 * marcador plano para interpretar la condición. Sin DB, sin env.
 *
 * Casos:
 *   1) primer run inserta los 5 planes reales (trial/creator/media/
 *      network/enterprise) con los features del catálogo.
 *   2) re-run inserta 0, completa 0 y no duplica filas.
 *   3) plan preexistente: completa sólo columnas NULL y NUNCA pisa
 *      priceUsd ni límites ajustados a mano.
 *   4) el trial queda isActive=false aunque haya quedado activo a mano.
 *   5) add-ons: inserta +5/+15; re-run no duplica.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Row {
    [key: string]: unknown;
    id: string;
}
interface EqMarker {
    __eq: { column: { name?: string }; value: unknown };
}

// ── Fake db en memoria (vi.hoisted: existe antes del mock factory) ──────────
const h = vi.hoisted(() => {
    const planRows: Row[] = [];
    const addonRows: Row[] = [];
    let seq = 0;
    // Se asigna a nivel de módulo (los objetos tabla recién existen ahí).
    const resolver: { fn: ((table: unknown) => Row[]) | null } = { fn: null };

    const keyOf = (column: { name?: string }): string =>
        (column.name ?? '').replace(/_([a-z])/g, (_, c: string) =>
            c.toUpperCase(),
        );

    const rowsOf = (table: unknown): Row[] => resolver.fn!(table);

    const match = (table: unknown, cond: EqMarker) =>
        rowsOf(table).filter(
            (r) => r[keyOf(cond.__eq.column)] === cond.__eq.value,
        );

    const from = (table: unknown) => {
        const rows = () => rowsOf(table);
        const thenable = {
            then: (res: (v: Row[]) => unknown) =>
                Promise.resolve(rows()).then(res),
        };
        return Object.assign(thenable, {
            where: (cond: EqMarker) => ({
                limit: (n: number) =>
                    Promise.resolve(match(table, cond).slice(0, n)),
            }),
            orderBy: () => Promise.resolve(rows()),
        });
    };

    const db = {
        select: (_cols?: unknown) => ({ from }),
        insert: (table: unknown) => ({
            values: (v: Record<string, unknown>) => {
                const rows = rowsOf(table);
                // Emula la clave UNIQUE que protege ON CONFLICT DO NOTHING.
                if (!rows.some((r) => r.name === v.name)) {
                    rows.push({ id: `id-${++seq}`, ...v });
                }
                return { onConflictDoNothing: async () => {} };
            },
        }),
        update: (table: unknown) => ({
            set: (patch: Record<string, unknown>) => ({
                where: (cond: EqMarker) => {
                    for (const r of match(table, cond)) Object.assign(r, patch);
                    return Promise.resolve();
                },
            }),
        }),
    };
    return { db, planRows, addonRows, resolver };
});

// `eq` como marcador plano interpretable por el fake (el resto queda real).
vi.mock('drizzle-orm', async (io) => {
    const actual = await io<typeof import('drizzle-orm')>();
    return {
        ...actual,
        eq: (column: unknown, value: unknown) => ({ __eq: { column, value } }),
    };
});

vi.mock('../src/server/db/index.js', async (io) => ({
    ...(await io()),
    db: h.db,
}));

import { PLAN_SEED, seedPlans } from '../src/server/services/planService';
import { seedAddons } from '../src/server/services/addonService';
import { plans, planAddons } from '../src/server/db/schema/index.js';

// Cableado tabla→filas del fake (comparación por identidad de objeto tabla).
h.resolver.fn = (table: unknown) =>
    table === plans ? h.planRows : h.addonRows;

afterEach(() => {
    h.planRows.length = 0;
    h.addonRows.length = 0;
    vi.restoreAllMocks();
});

describe('seedPlans — catálogo real de planes (idempotente)', () => {
    it('(1) primer run inserta los 5 planes reales del producto', async () => {
        const res = await seedPlans();
        expect(res.inserted.sort()).toEqual(
            ['trial', 'creator', 'media', 'network', 'enterprise'].sort(),
        );
        expect(res.updated).toHaveLength(0);
        expect(h.planRows).toHaveLength(5);
        const creator = h.planRows.find((r) => r.name === 'creator')!;
        expect(creator.priceUsd).toBe('29');
        expect(creator.transmissionsPerCycle).toBe(20);
        expect(creator.features).toBeTypeOf('object');
        // El trial no aparece en la grilla pública.
        expect(h.planRows.find((r) => r.name === 'trial')!.isActive).toBe(false);
        expect(h.planRows.map((r) => r.name)).toEqual(PLAN_SEED.map((p) => p.name));
    });

    it('(2) re-run: inserta 0, completa 0, no duplica', async () => {
        await seedPlans();
        const second = await seedPlans();
        expect(second.inserted).toHaveLength(0);
        expect(second.updated).toHaveLength(0);
        expect(h.planRows).toHaveLength(5);
    });

    it('(3) plan existente: completa NULLs y nunca pisa precios/límites manuales', async () => {
        h.planRows.push({
            id: 'id-manual',
            name: 'creator',
            displayName: 'Creator',
            description: null,
            priceUsd: '39', // ajustado a mano — no se toca
            transmissionsPerCycle: null, // columna NULL → se completa
            maxTransmissionMinutes: 90,
            maxClipsPerTransmission: 6,
            maxPeople: 15,
            rawRetentionDays: 7,
            maxTeamMembers: 3,
            maxStorageGb: 20,
            isActive: true,
            sortOrder: 1,
            features: {},
        });
        const res = await seedPlans();
        expect(res.inserted.sort()).toEqual(
            ['trial', 'media', 'network', 'enterprise'].sort(),
        );
        expect(res.updated).toEqual(['creator']);
        const creator = h.planRows.find((r) => r.name === 'creator')!;
        expect(creator.priceUsd).toBe('39'); // preservado
        expect(creator.transmissionsPerCycle).toBe(20); // completado
        expect(creator.description).not.toBeNull(); // completado
        expect(h.planRows).toHaveLength(5);
    });

    it('(4) repara un trial que quedó isActive=true a mano', async () => {
        h.planRows.push({
            id: 'id-trial',
            name: 'trial',
            displayName: 'Prueba',
            description: 'x',
            priceUsd: '0',
            transmissionsPerCycle: 2,
            maxTransmissionMinutes: 60,
            maxClipsPerTransmission: 3,
            maxPeople: 5,
            rawRetentionDays: 3,
            maxTeamMembers: 1,
            maxStorageGb: 2,
            isActive: true, // roto a mano
            sortOrder: -1,
            features: {},
        });
        const res = await seedPlans();
        expect(res.updated).toContain('trial');
        expect(h.planRows.find((r) => r.name === 'trial')!.isActive).toBe(false);
    });
});

describe('seedAddons — catálogo de add-ons (idempotente)', () => {
    it('(5) inserta +5/+15 y el re-run no duplica', async () => {
        const first = await seedAddons();
        expect(first.inserted.sort()).toEqual(['+15', '+5']);
        expect(h.addonRows).toHaveLength(2);
        const plus5 = h.addonRows.find((r) => r.name === '+5')!;
        expect(plus5.transmissions).toBe(5);
        expect(plus5.priceUsd).toBe('19.00');

        const second = await seedAddons();
        expect(second.inserted).toHaveLength(0);
        expect(h.addonRows).toHaveLength(2);
    });
});
