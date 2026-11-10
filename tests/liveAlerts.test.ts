/**
 * Tests del slice PE-07: `liveAlertsService` — reuso de `detectAlerts` sobre
 * la transcripción nueva.
 *
 * Deterministas: memory store (keywords/programa por tenant), notify y emit
 * stubbed, línea editorial inyectada. Gemini no corre en tests (sin API key)
 * → el camino ejercitado es keyword matching, que es el camino garantizado.
 */
import { describe, expect, it, vi } from 'vitest';

import type { LiveAlert } from '../src/shared/types.js';
import { createLiveAlertsService } from '../src/server/services/liveAlertsService';
import { createMemoryLiveAlertsStore } from './helpers/memoryLiveAlertsStore';

const T_A = 'tenant-a';
const T_B = 'tenant-b';
const TX_1 = 'tx-1';

function makeService(opts: {
    keywords?: Record<string, string[]>;
    transmissions?: Record<string, { tenantId: string; programId: string | null }>;
}) {
    const { store, state, setKeywords, setTransmissionProgram } =
        createMemoryLiveAlertsStore();
    for (const [t, kws] of Object.entries(opts.keywords ?? {})) setKeywords(t, kws);
    for (const [txId, v] of Object.entries(opts.transmissions ?? {})) {
        setTransmissionProgram(v.tenantId, txId, v.programId);
    }

    const emitted: Array<{ tenantId: string; alert: LiveAlert }> = [];
    const notifications: Array<Record<string, unknown>> = [];
    const resolveEditorialBlock = vi.fn(async () => 'BLOQUE-EDITORIAL');

    const service = createLiveAlertsService(store, {
        emitAlert: (tenantId, alert) => emitted.push({ tenantId, alert }),
        resolveEditorialBlock,
        notifyFn: (async (p: Record<string, unknown>) => {
            notifications.push(p);
            return { id: 'notif-1' };
        }) as never,
    });

    return { service, state, emitted, notifications, resolveEditorialBlock };
}

describe('checkTranscriptAlerts — keyword path', () => {
    it('detecta keyword, notifica y emite live_alert al tenant', async () => {
        const { service, emitted, notifications } = makeService({
            keywords: { [T_A]: ['inflación'] },
        });

        const alerts = await service.checkTranscriptAlerts({
            tenantId: T_A,
            transmissionId: TX_1,
            text: 'El ministro habló de la inflación interanual y las tarifas.',
        });

        expect(alerts).toHaveLength(1);
        expect(alerts[0].type).toBe('keyword');
        expect(alerts[0].matchedKeyword).toBe('inflación');

        expect(notifications).toHaveLength(1);
        expect(notifications[0].tenantId).toBe(T_A);
        expect(notifications[0].type).toBe('alert_keyword');
        expect((notifications[0].metadata as Record<string, unknown>).transmissionId).toBe(TX_1);

        expect(emitted).toHaveLength(1);
        expect(emitted[0].tenantId).toBe(T_A);
        expect(emitted[0].alert.matchedKeyword).toBe('inflación');
    });

    it('sin keywords configuradas no notifica ni emite', async () => {
        const { service, emitted, notifications } = makeService({});

        const alerts = await service.checkTranscriptAlerts({
            tenantId: T_A,
            text: 'Un fragmento sin nada relevante.',
        });

        expect(alerts).toEqual([]);
        expect(notifications).toEqual([]);
        expect(emitted).toEqual([]);
    });

    it('texto vacío no hace nada (ni lee keywords)', async () => {
        const { service, emitted, notifications } = makeService({
            keywords: { [T_A]: ['inflación'] },
        });

        const alerts = await service.checkTranscriptAlerts({ tenantId: T_A, text: '   ' });
        expect(alerts).toEqual([]);
        expect(notifications).toEqual([]);
        expect(emitted).toEqual([]);
    });
});

describe('aislamiento por tenant', () => {
    it('usa las keywords del tenant propio, no las de otro', async () => {
        const { service, emitted } = makeService({
            keywords: { [T_B]: ['inflación'] },
        });

        // tenant-a no tiene keywords: su fragmento con "inflación" no alerta.
        const alerts = await service.checkTranscriptAlerts({
            tenantId: T_A,
            text: 'Hablaron de inflación todo el segmento.',
        });
        expect(alerts).toEqual([]);
        expect(emitted).toEqual([]);
    });
});

describe('contexto editorial', () => {
    it('resuelve la línea editorial con el program_id de la transmisión', async () => {
        const { service, resolveEditorialBlock } = makeService({
            keywords: { [T_A]: ['x'] },
            transmissions: { [TX_1]: { tenantId: T_A, programId: 'prog-9' } },
        });

        await service.checkTranscriptAlerts({
            tenantId: T_A,
            transmissionId: TX_1,
            text: 'texto de x mencionado',
        });

        expect(resolveEditorialBlock).toHaveBeenCalledWith(T_A, 'prog-9');
    });
});
