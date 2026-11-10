# PE-06 — Segmentos: `transmission_segments` (tema, resumen, speakers, ventana temporal)

KANBAN_TASK_ID: t_d2f3cad5
Slice de: ÉPICA E — Motor de análisis en vivo
Ejecutor: devin-swe-2-max (sesión de orquestación en worktree master)
Base: 260680b (master tip — incluye PE-01 mergeado)

## Objetivo

Crear la tabla `transmission_segments` y su servicio — la unidad editorial que el
motor de análisis (PE-02) va a escribir por ventana: tema, resumen, speakers y
ventana temporal. Mismo contrato que `transcript_segments`/`transmission_moments`
(PD-05): offsets relativos a `transmissions.started_at`, `tenant_id` en todo.

## Alcance

- `src/server/db/schema/live.ts`: nueva tabla `transmission_segments`
  (tenantId, transmissionId, startMs/endMs bigint, topic varchar(200),
  summary text, speakers jsonb `{label, personId?}[]`, confidence real,
  createdAt) + índices tenant / (transmission,start_ms).
- Migración drizzle (`npx drizzle-kit generate`) + `node scripts/verify-migration-pglite.mjs`.
- `src/server/services/transmissionSegmentsService.ts`: interface `SegmentsStore`
  + impl drizzle + factory `createTransmissionSegmentsService(store)` (patrón
  de `streamRecorderService`/`transmissionSchedulerService`).
- `tests/helpers/memorySegmentsStore.ts` + `tests/transmissionSegments.test.ts`.

## Gates

- [ ] `npx tsc --noEmit` → EXIT 0
- [ ] `node scripts/verify-migration-pglite.mjs` → la migración aplica limpio
- [ ] `npx vitest run` → verde, sin regresiones
- [ ] `npm run build` → verde

## Límites

- NO push, NO PR. Commit conventional en rama `pe-06-transmission-segments`, sin atribución IA.
- `tenant_id` en TODA query. El engine (PE-02) es quien poblará la tabla — este
  slice deja el contrato y el camino de escritura/lectura, no el análisis.
- NO tocar `streamRecorderService.ts` ni `transcript_segments`/`transmission_moments`.
