/**
 * memoryRunnerStore — implementación en memoria de `LiveAnalysisRunnerStore`
 * para tests del runner de análisis en vivo (PE-04). Sin DB: el mismo
 * filtro por tenant que la implementación drizzle (un id ajeno al tenant no
 * se encuentra → null).
 *
 * `state.calls` loggea `{tenantId, transmissionId}` de cada lectura — el
 * test de aislamiento lo usa para verificar el tenant-scoping.
 */
import type { LiveAnalysisRunnerStore } from '../../src/server/services/liveAnalysisRunner';
import type { TransmissionRow } from '../../src/server/services/transmissionService';

export interface MemoryRunnerState {
    transmissions: Map<string, TransmissionRow>;
    calls: Array<{ tenantId: string; transmissionId: string }>;
}

export function createMemoryRunnerStore(seed: {
    transmissions?: TransmissionRow[];
} = {}): { store: LiveAnalysisRunnerStore; state: MemoryRunnerState } {
    const state: MemoryRunnerState = {
        transmissions: new Map(
            (seed.transmissions ?? []).map((t) => [`${t.tenantId}/${t.id}`, t]),
        ),
        calls: [],
    };

    const store: LiveAnalysisRunnerStore = {
        async getTransmission(tenantId, transmissionId) {
            state.calls.push({ tenantId, transmissionId });
            return state.transmissions.get(`${tenantId}/${transmissionId}`) ?? null;
        },
    };

    return { store, state };
}
