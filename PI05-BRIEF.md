# PI-05 — Backup/retención de assets + política de borrado de crudos

Slice de ÉPICA I (`docs/EPICA-I.md`, línea: "PI-05 Backup/retención de assets +
política de borrado de crudos [2 pts]"). Base: `origin/master @8e9a36e`.

## Lo que YA existe — auditar, NO reimplementar

- `src/server/services/rawRetentionService.ts` — purga del CRUDO por plan
  (`plans.raw_retention_days`), job `retention.purge` ya registrado en
  `jobQueueWorker.ts`, endpoint admin en `routes/admin.ts`. Completo desde PD-06.
- `src/server/services/rawStorageService.ts` — adapter `RawStorage`
  (FilesystemRawStorage, raíz `STORAGE_ROOT` o `<repo>/data/raw`), sanea path
  traversal, `deletePrefix`. El punto de extensión para S3/R2 ya está diseñado.

**Auditar** el servicio de retención: confirmar que corre via job queue, que hay
endpoint admin con dry-run, y documentar cualquier gap real (métricas, visibilidad
admin). No reescribirlo.

## Lo que FALTA — implementar

### 1. `assetBackupService.ts` — backup de assets derivados

Espejo incremental de los assets que el producto genera (renders de clips,
flyers, material publicado) hacia un prefijo de backup, usando el MISMO patrón
de adapter que `RawStorage`:

- `BackupStorage` interface con implementación filesystem
  (`BACKUP_ROOT` env o `<repo>/data/backup`). Diseñarla para que un backend
  S3/R2 la implemente después sin tocar consumidores — misma filosofía que
  `rawStorageService.ts`.
- Manifest por tenant: tabla `asset_backup_entries` (o jsonb liviano si la
  convención del repo lo permite — decidir mirando `schema/` y justificar en el
  commit): `{ tenant_id, source_path, backup_path, bytes, checksum?, backed_up_at,
  status }`. Sirve para idempotencia y para reportar cobertura.
- Fuentes: escanear dónde viven los archivos derivados (clips renderizados,
  `publications.quote_flyer_paths`, etc. — leer `schema/assets.ts`,
  `schema/clips.ts`, `clipCutterService.ts`). TODO path que pase por el adapter,
  nunca `fs` directo.
- Idempotente: re-correr copia sólo lo nuevo/modificado (por checksum o por
  mtime+size si checksum es caro — decidir y documentar).
- Tenant-scoped en TODA escritura (regla dura del repo).
- `dryRun` mode igual que `purgeExpiredRecordings`.

### 2. Job `backup.sync` en la cola existente

- Handler registrado en `jobQueueWorker.ts` como `retention.purge` (ver
  `createRetentionPurgeHandler` — mismo patrón, deps inyectables).
- Programación: enqueued periódicamente o por tenant (mirar cómo se encola el
  purge hoy y seguirlo).

### 3. Admin endpoint

- `POST /admin/backup/sync` (dryRun opcional) + `GET /admin/backup/status`
  (última corrida, cobertura por tenant: entries, bytes). Mismo estilo que el
  endpoint del purge en `routes/admin.ts`.

### 4. Tests (vitest, memory stores)

- Casos: primera corrida copia todo, segunda es no-op, archivo nuevo se copia,
  dry-run no escribe, tenant A no ve/purga lo de tenant B, error en un asset no
  aborta el job (va a `errors[]`).
- Mismo estilo de inyección de deps que los tests de rawRetentionService.

## Gates obligatorios (EXIT real)

```bash
npx tsc --noEmit
npx vitest run
npm run build
git diff --check
```

## Reglas

- Conventional commits, sin "Co-Authored-By" ni atribución AI.
- Commitear el brief como `chore(ops): preserve PI-05 slice brief` al final.
- Actualizar `docs/EPICA-I.md`: marcar el ítem y anotar evidencia
  (archivos, tests, qué se auditó de retención).
- NO tocar migraciones contra DB real; si hace falta tabla nueva, generar la
  migración drizzle como en slices anteriores (PGlite verifier si aplica).
