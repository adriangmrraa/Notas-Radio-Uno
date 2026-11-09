/**
 * dossierLink — reglas puras del vínculo dossier ↔ emisión de agenda (PC-09).
 *
 * Sin DB: la consulta a `scheduled_transmissions` la hace el servicio y acá se
 * valida la TUPLA (tenant, programa del invitado, fila encontrada). Las rutas
 * mapean el `AppError` a su statusCode (404 = ajena/inexistente — no se
 * distingue; 400 = programa incompatible).
 *
 * `dossierMatchesListFilters` es el contrato de `GET /api/dossiers`: el mismo
 * predicado que filtra en memoria también documenta qué condiciones aplica el
 * origen drizzle (tenant siempre; programId/date/scheduledTransmissionId
 * opcionales).
 */
import { AppError } from './errors.js';

// ---------------------------------------------------------------------------
// Vínculo dossier → scheduled_transmissions
// ---------------------------------------------------------------------------

export interface DossierTransmissionCandidate {
    id: string;
    tenantId: string;
    programId: string | null;
}

/**
 * Valida que una entrada de agenda pueda vincularse al dossier del invitado.
 *
 *   - No existe o es de otro tenant ⇒ 404 (mismo criterio que el resto de la
 *     API: un id ajeno es indistinguible de uno inexistente).
 *   - Su `program_id` (si tiene) no coincide con el del invitado ⇒ 400.
 *   - `program_id` NULL (emisión sin programa asignado) ⇒ vínculo válido.
 */
export function assertDossierTransmissionLink(
    tenantId: string,
    guestProgramId: string,
    transmission: DossierTransmissionCandidate | null,
): void {
    if (!transmission || transmission.tenantId !== tenantId) {
        throw new AppError('Transmisión programada no encontrada', 404);
    }
    if (transmission.programId && transmission.programId !== guestProgramId) {
        throw new AppError(
            'La transmisión programada pertenece a otro programa',
            400,
        );
    }
}

// ---------------------------------------------------------------------------
// Filtros del listado de dossiers
// ---------------------------------------------------------------------------

export interface DossierListFilters {
    programId?: string;
    date?: string;
    scheduledTransmissionId?: string;
}

export interface DossierListRow {
    tenantId: string;
    programId: string;
    scheduledDate: string;
    scheduledTransmissionId: string | null;
}

/**
 * Predicado del listado: la fila entra si es del tenant y cumple TODOS los
 * filtros presentes. `tenantId` se re-chequea acá aunque el origen ya filtre
 * en SQL — la regla de aislamiento queda testeable y a prueba de orígenes
 * alternativos.
 */
export function dossierMatchesListFilters(
    row: DossierListRow,
    tenantId: string,
    filters: DossierListFilters,
): boolean {
    if (row.tenantId !== tenantId) return false;
    if (filters.programId && row.programId !== filters.programId) return false;
    if (filters.date && row.scheduledDate !== filters.date) return false;
    if (
        filters.scheduledTransmissionId &&
        row.scheduledTransmissionId !== filters.scheduledTransmissionId
    ) {
        return false;
    }
    return true;
}
