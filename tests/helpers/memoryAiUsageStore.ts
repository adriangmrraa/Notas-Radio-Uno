/**
 * memoryAiUsageStore — implementación en memoria de `AiUsageStore` para los
 * tests del ledger de consumo de IA (PI-03). Sin DB:
 *
 *   - `insertEvent` agrega la fila tal cual la devolvería `.returning()`
 *     del drizzle (id/createdAt sintéticos cuando faltan).
 *   - `summarize` delega en `summarizeUsageRows` — la agregación pura de
 *     referencia del service — así el memory store reproduce EXACTAMENTE
 *     la semántica del SQL (filtros tenant/feature/rango, group-bys,
 *     orden por costo desc, tope del ranking).
 *   - `failOnInsert` simula una caída de la tabla: insertEvent rechaza —
 *     el registro best-effort tiene que seguir resolviendo.
 */
import {
  summarizeUsageRows,
  type AiUsageEventRow,
  type AiUsageStore,
  type NewAiUsageEvent,
} from '../../src/server/services/aiUsageService';

export interface MemoryAiUsageState {
  events: AiUsageEventRow[];
}

let seq = 0;
const nextId = () =>
  `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

/** Fila completa como la devolvería `.returning()` del drizzle. */
export function makeMemoryAiUsageEvent(
  v: Partial<NewAiUsageEvent> & { tenantId: string },
  now: () => Date = () => new Date(),
): AiUsageEventRow {
  return {
    id: v.id ?? nextId(),
    tenantId: v.tenantId,
    transmissionId: v.transmissionId ?? null,
    feature: v.feature ?? 'test-feature',
    provider: v.provider ?? 'deepseek',
    model: v.model ?? 'deepseek-chat',
    promptTokens: v.promptTokens ?? 0,
    completionTokens: v.completionTokens ?? 0,
    totalTokens: v.totalTokens ?? 0,
    estimatedCostUsd: v.estimatedCostUsd ?? null,
    success: v.success ?? true,
    error: v.error ?? null,
    durationMs: v.durationMs ?? null,
    createdAt: v.createdAt ?? now(),
  };
}

export function createMemoryAiUsageStore(opts?: {
  events?: Array<Partial<NewAiUsageEvent> & { tenantId: string }>;
  /** Reloj para defaults `defaultNow`/`defaultRandom`. */
  now?: () => Date;
  /** true ⇒ insertEvent rechaza (tabla caída) — el service no debe romperse. */
  failOnInsert?: boolean;
}): { store: AiUsageStore; state: MemoryAiUsageState } {
  const now = opts?.now ?? (() => new Date());
  const state: MemoryAiUsageState = {
    events: (opts?.events ?? []).map((e) => makeMemoryAiUsageEvent(e, now)),
  };

  const store: AiUsageStore = {
    async insertEvent(v: NewAiUsageEvent) {
      if (opts?.failOnInsert) {
        throw new Error('insert falló (tabla simulada caída)');
      }
      const row = makeMemoryAiUsageEvent(v, now);
      state.events.push(row);
      return row;
    },

    async summarize(filter) {
      return summarizeUsageRows(state.events, filter);
    },
  };

  return { store, state };
}
