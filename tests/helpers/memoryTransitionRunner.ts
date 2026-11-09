/**
 * memoryTransitionRunner — `TransitionRunner` sobre filas en memoria para
 * los tests de servicios que delegan el cambio de estado en PD-04
 * (scheduler, recorder). Replica la semántica real:
 *
 *   - lookup por (tenantId, transmissionId) — un id ajeno al tenant no se
 *     encuentra → "transmisión no encontrada", igual que el WHERE tenant_id.
 *   - Valida la arista con la FSM REAL (`transition` de
 *     transmissionStateMachine) — un test no puede pasar por un estado que
 *     la FSM rechaza.
 *   - Aplica el UPDATE con `computeTransitionUpdate` REAL (mismas reglas de
 *     timestamps / error_message que el servicio drizzle).
 *   - Emite `transmission:status` + `transmission:updated` por `onEmit`,
 *     como el emisor canónico — los tests registran la secuencia y
 *     verifican que el evento sale DESPUÉS de aplicar el cambio.
 */
import { transition } from '../../src/server/lib/transmissionStateMachine';
import {
  computeTransitionUpdate,
  type TransitionOptions,
  type TransitionResult,
  type TransmissionRow,
} from '../../src/server/services/transmissionService';
import type { TransmissionStatus } from '../../src/server/db/schema/enums';

/**
 * Campos mínimos que el runner lee/pisa de una fila en memoria. No lleva
 * firma de índice a propósito: los rows tipados de los stores (MemoryRun,
 * MemoryTransmission) no la declaran y así siguen siendo asignables.
 */
export interface MemoryTransitionRow {
  status: string;
  waitingSince?: Date | null;
  errorMessage?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
  crudoRef?: string | null;
  resolvedStreamUrl?: string | null;
}

export interface EmittedTransmissionEvent {
  tenantId: string;
  event: 'transmission:status' | 'transmission:updated';
  payload: Record<string, unknown>;
}

export function createMemoryTransitionRunner<Row extends MemoryTransitionRow>(opts: {
  find: (tenantId: string, transmissionId: string) => Row | undefined;
  onEmit?: (e: EmittedTransmissionEvent) => void;
  now?: () => Date;
}): (o: TransitionOptions) => Promise<TransitionResult> {
  return async (o) => {
    const row = opts.find(o.tenantId, o.transmissionId);
    if (!row) {
      return { ok: false, reason: 'transmisión no encontrada' };
    }
    const previousStatus = row.status as TransmissionStatus;
    const decision = transition(previousStatus, o.to);
    if (!decision.allowed) {
      return { ok: false, reason: decision.reason };
    }

    const update = computeTransitionUpdate({
      currentStatus: previousStatus,
      currentWaitingSince: row.waitingSince ?? null,
      to: o.to,
      errorMessage: o.errorMessage,
      patch: o.patch,
      now: opts.now?.() ?? new Date(),
    });
    // El UPDATE ya validó la arista: se aplica DESPUÉS, igual que el commit.
    Object.assign(row, update);

    opts.onEmit?.({
      tenantId: o.tenantId,
      event: 'transmission:status',
      payload: {
        transmissionId: o.transmissionId,
        tenantId: o.tenantId,
        status: update.status,
        previousStatus,
        startedAt: row.startedAt ?? null,
        endedAt: row.endedAt ?? null,
        errorMessage: row.errorMessage ?? null,
        crudoRef: row.crudoRef ?? null,
        updatedAt: update.updatedAt,
      },
    });
    opts.onEmit?.({
      tenantId: o.tenantId,
      event: 'transmission:updated',
      payload: { ...(row as Record<string, unknown>) },
    });

    return { ok: true, transmission: row as unknown as TransmissionRow };
  };
}
