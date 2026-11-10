/**
 * memoryLiveAlertsStore — implementación en memoria de `LiveAlertsStore`
 * para tests de `liveAlertsService` (PE-07). Keywords por tenant y
 * program_id por (tenant, transmisión) — mismo aislamiento que la impl
 * drizzle: un transmissionId ajeno al tenant devuelve null.
 */
import type { LiveAlertsStore } from '../../src/server/services/liveAlertsService';

export interface MemoryLiveAlertsState {
    keywords: Map<string, string[]>;
    transmissionPrograms: Map<string, string | null>;
}

export function createMemoryLiveAlertsStore(): {
    store: LiveAlertsStore;
    state: MemoryLiveAlertsState;
    setKeywords(tenantId: string, keywords: string[]): void;
    setTransmissionProgram(tenantId: string, transmissionId: string, programId: string | null): void;
} {
    const state: MemoryLiveAlertsState = {
        keywords: new Map(),
        transmissionPrograms: new Map(),
    };

    return {
        state,
        setKeywords(tenantId, keywords) {
            state.keywords.set(tenantId, keywords);
        },
        setTransmissionProgram(tenantId, transmissionId, programId) {
            state.transmissionPrograms.set(`${tenantId}:${transmissionId}`, programId);
        },
        store: {
            async getAlertKeywords(tenantId) {
                return state.keywords.get(tenantId) ?? [];
            },
            async getTransmissionProgramId(tenantId, transmissionId) {
                return state.transmissionPrograms.get(`${tenantId}:${transmissionId}`) ?? null;
            },
        },
    };
}
