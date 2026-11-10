/**
 * liveAlertsService — alertas en vivo sobre la transcripción NUEVA (PE-07).
 *
 * Reusa `alertService.detectAlerts` (keywords + análisis semántico Gemini)
 * sobre el texto que el motor de ÉPICA E escribe en `transcript_segments`.
 * El pipeline viejo (`pipelineService.detectAndEmitAlerts`) hace lo mismo
 * sobre su propia captura — este servicio expone el mismo camino para el
 * flujo nuevo sin tocarlo:
 *
 *   utterance/chunk nuevo → checkTranscriptAlerts() → por cada LiveAlert:
 *     1. notificación persistida vía notificationService.notify()
 *        (type `alert_<type>`, emite `notification` al room tenant:{id})
 *     2. evento `live_alert` emitido al room `tenant:{id}` — el hook
 *        `useLiveAlerts` / `LiveAlertFeed` del cliente ya lo escuchan.
 *
 * Mismo patrón Store que el resto de servicios: interface + impl drizzle +
 * factory — los tests usan memoryLiveAlertsStore (sin DB ni sockets).
 */
import { and, eq } from 'drizzle-orm';
import type { Server } from 'socket.io';

import type { LiveAlert } from '../../shared/types.js';
import { db, type Database } from '../db/index.js';
import { transmissions } from '../db/schema/transmissions.js';
import { getSetting } from './databaseService.js';
import { resolveEditorialPromptBlock } from './editorialPromptService.js';
import { notify } from './notificationService.js';
import { detectAlerts } from './alertService.js';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface CheckTranscriptInput {
  tenantId: string;
  /** Opcional: enriquece metadata + resuelve línea editorial del programa. */
  transmissionId?: string;
  /** Opcional: perfil editorial por programa sin transmisión (tests/manual). */
  programId?: string | null;
  text: string;
  /** Contexto de speakers (reservado, mismo contrato que detectAlerts). */
  speakerContext?: string | null;
}

export interface LiveAlertsDeps {
  /** Emisor de `live_alert` — en prod cableado a io; en tests, stub. */
  emitAlert?: (tenantId: string, alert: LiveAlert) => void;
  /** Resolución de línea editorial — inyectable para tests. */
  resolveEditorialBlock?: (tenantId: string, programId: string | null) => Promise<string>;
  /** Persistencia de la notificación — en prod notificationService.notify. */
  notifyFn?: typeof notify;
}

// ---------------------------------------------------------------------------
// Store — todo acceso a datos/config filtrado por tenant_id
// ---------------------------------------------------------------------------

export interface LiveAlertsStore {
  /** Keywords de alerta configuradas por el tenant (setting `alert_keywords`). */
  getAlertKeywords(tenantId: string): Promise<string[]>;
  /** program_id de la transmisión (para contexto editorial), tenant-scoped. */
  getTransmissionProgramId(
    tenantId: string,
    transmissionId: string,
  ): Promise<string | null>;
}

/** Implementación drizzle — todas las queries filtran por tenant_id. */
export function createDrizzleLiveAlertsStore(executor: Database = db): LiveAlertsStore {
  return {
    async getAlertKeywords(tenantId) {
      try {
        const raw = await getSetting('alert_keywords', tenantId);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed)
          ? parsed.filter((k): k is string => typeof k === 'string')
          : [];
      } catch {
        return [];
      }
    },

    async getTransmissionProgramId(tenantId, transmissionId) {
      const [row] = await executor
        .select({ programId: transmissions.programId })
        .from(transmissions)
        .where(
          and(
            eq(transmissions.id, transmissionId),
            eq(transmissions.tenantId, tenantId),
          ),
        )
        .limit(1);
      if (!row) return null;
      return row.programId ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Emisión por socket — mirroring de initNotificationService
// ---------------------------------------------------------------------------

let ioRef: Server | null = null;

export function initLiveAlertsService(io: Server) {
  ioRef = io;
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

const ALERT_ICONS: Record<LiveAlert['type'], string> = {
  breaking_news: '🔴',
  strong_statement: '⚡',
  key_data: '📊',
  emotional_peak: '🔥',
  keyword: '🏷️',
};

export function createLiveAlertsService(
  store: LiveAlertsStore = createDrizzleLiveAlertsStore(),
  deps: LiveAlertsDeps = {},
) {
  const emitAlert =
    deps.emitAlert ??
    ((tenantId: string, alert: LiveAlert) => {
      ioRef?.to(`tenant:${tenantId}`).emit('live_alert', alert);
    });
  const resolveEditorialBlock = deps.resolveEditorialBlock ?? resolveEditorialPromptBlock;
  const notifyFn = deps.notifyFn ?? notify;

  return {
    /**
     * Analiza un fragmento de la transcripción nueva y dispara alertas.
     * Fire-and-forget desde el caller (como en el pipeline viejo): este
     * método no lanza — un fallo de detección/devolución no corta la
     * transcripción. Devuelve las alertas emitidas.
     */
    async checkTranscriptAlerts(input: CheckTranscriptInput): Promise<LiveAlert[]> {
      const text = input.text?.trim();
      if (!text) return [];

      const keywords = await store.getAlertKeywords(input.tenantId);
      let programId = input.programId ?? null;
      if (!programId && input.transmissionId) {
        programId = await store.getTransmissionProgramId(input.tenantId, input.transmissionId);
      }
      const editorialBlock = await resolveEditorialBlock(input.tenantId, programId);

      const alerts = await detectAlerts(text, keywords, input.speakerContext, editorialBlock);

      for (const alert of alerts) {
        await notifyFn({
          tenantId: input.tenantId,
          type: `alert_${alert.type}`,
          title: alert.title,
          message: alert.excerpt,
          icon: ALERT_ICONS[alert.type] ?? '🔔',
          metadata: {
            severity: alert.severity,
            context: alert.context,
            speaker: alert.speaker,
            matchedKeyword: alert.matchedKeyword,
            alertType: alert.type,
            transmissionId: input.transmissionId ?? null,
          },
        }).catch((err: Error) => {
          console.warn('[LiveAlerts] Error saving alert notification:', err.message);
        });

        emitAlert(input.tenantId, alert);
      }

      return alerts;
    },
  };
}

export const liveAlertsService = createLiveAlertsService();
