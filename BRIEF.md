# BRIEF — PF-10 Modelo `assets` unificado + estados editoriales (ledger sobre clips/publications)

**KANBAN_TASK_ID**: t_682756fa (ÉPICA F — PF-10, 5 pts — CIERRA LA ÉPICA)
**Base**: `35bf992` (master tip)
**Branch**: `pf-10-unified-assets`
**Worktree**: `C:/Users/Asus/orca/workspaces/periodistapp/pf-10-unified-assets`

## Contexto

Después de PF-01..09 el contenido vive en DOS tablas: `clips` (videos: cut/reframe/subs)
y `publications` (notas, con quote_flyer_paths + contentVariants). La épica pide un
**modelo `assets` unificado (clip/nota/flyer/post) con estados editoriales**.

**Decisión de diseño (explícita — no negociable en el slice)**: `assets` es un **ledger
editorial unificado**, NO una migración destructiva de las tablas existentes — un merge
real de clips+publications tocaría los 9 slices que ya las consumen (blast radius
enorme, no entra en 5pts ni es seguro). El ledger:
- 1 fila por artefacto generado, referencia estable `(source_table, ref_id)` UNIQUE
- estados editoriales CANÓNICOS mapeados desde los statuses legacy
- transiciones write-through: actualizar el asset también actualiza el status de la
  fila fuente (los consumers viejos siguen viendo su estado)

Contratos (verificados):
- `clips`: id, title, status ('generating'|'pending_review'|'ready'|'error'|...),
  videoPath, transmissionId, metadata jsonb
- `publications`: id, title, status ('pending_review'|'approved'|'published'|
  'rejected'), quotes, quoteFlyerPaths, contentVariants — SIN transmissionId
- Statuses legacy heterogéneos → mapeo canónico obligatorio (map puro testeable).
- Migración: `npx drizzle-kit generate` + verificación pglite
  (`scripts/verify-migration-pglite.mjs` — agregar sección PF-10 como hizo PF-04).

## Alcance

### 1) Schema — `assets` (tabla nueva, migración 0015)

`src/server/db/schema/assets.ts` + export en index.ts + relations si aplica:

- `id` uuid PK, `tenant_id` NOT NULL FK tenants cascade + index
- `kind` varchar(16) NOT NULL — 'clip' | 'note' | 'flyer' | 'post'
- `source_table` varchar(24) NOT NULL — 'clips' | 'publications'
- `ref_id` uuid NOT NULL — id de la fila fuente (SIN FK: flyer apunta a path, no row;
  documentar por qué no hay FK)
- `parent_asset_id` uuid NULL FK self (flyer→nota, variant→nota, post→cualquiera)
- `title` text NULL, `status` varchar(20) NOT NULL default 'draft'
- `payload` jsonb NOT NULL default {} — kind-specific: {videoPath} | {content} |
  {flyerPath, quoteIndex} | {network, copy, hashtags}
- `transmission_id` uuid NULL FK transmissions set null + index
- `created_at`, `updated_at` (patrón repo)
- UNIQUE compuesto `(tenant_id, source_table, ref_id)` — idempotencia del sync
- Índices: `(tenant_id, kind)`, `(tenant_id, status)`

### 2) `assetsService.ts` — Store pattern + máquina de estados

`AssetStore` + `createDrizzleAssetStore`:
- `upsertAsset(row)` — ON CONFLICT (tenant_id, source_table, ref_id) DO UPDATE
  title/payload/updated_at (status NO se pisa si el asset ya transicionó manualmente —
  conflicto preserva status; sync nunca retrocede un estado editorial)
- `listAssets(tenantId, {kind?, status?, transmissionId?})`, `getAsset(id, tenantId)`
- `setAssetStatus(id, tenantId, status)` + `updateSourceStatus(source_table, ref_id,
  tenantId, statusLegacy)` — write-through
- Lectores del sync: `listClips(tenantId, transmissionId?)`,
  `listPublications(tenantId)`, `listPublicationFlyerPaths(pubId)` (del jsonb)

**Máquina de estados canónica** (`ASSET_STATES`): draft → pending_review → approved →
published | archived (desde pending_review/approved). `canTransition(from,to)` pura.
`mapLegacyStatus(source_table, legacyStatus)` → canónico (pura):
- clips: generating→draft, pending_review→pending_review, ready→approved,
  published→published, error→draft + metadata.error
- publications: pending_review→pending_review, approved→approved,
  published→published, rejected→archived

`syncAssets({tenantId, transmissionId?})` — el CORAZÓN del ledger:
- Por cada clip del tenant (o de la transmisión): upsert {kind:'clip',
  source_table:'clips', ref_id:clip.id, title, status:map(clip.status),
  payload:{videoPath, duration}, transmission_id:clip.transmissionId}
- Por cada publication: upsert {kind:'note', ref_id:pub.id, payload:{content}}
- Por cada flyerPath en pub.quoteFlyerPaths[i]: upsert {kind:'flyer',
  ref_id: <uuid derivado determinista — pubId + índice via uuid v5 o string estable
  en payload.quoteIndex; elegir y documentar>, parent_asset_id: asset de la nota,
  payload:{flyerPath, quoteIndex:i}}
- Return {upserted, byKind}

`transitionAsset({tenantId, assetId, to})` → valida canTransition → setAssetStatus +
`updateSourceStatus` (legacy inverso: approved→clips 'ready' / publications 'approved',
published→'published', archived→publications 'rejected'?? NO — archived no tiene
legacy; documentar: archived solo toca el asset) → asset actualizado.
`invalid_transition` si canTransition falla.

### 3) Endpoint — `routes/assets.ts` (nuevo, patrón notes.ts)

- `GET /api/assets?kind&status&transmissionId` → `{assets}`
- `POST /api/assets/sync {transmissionId?}` → `{upserted, byKind}`
- `POST /api/assets/:id/transition {to}` → 200 {asset} / 409 invalid_transition / 404
`req.auth!.tenantId`; deps inyectables patrón repo.

### 4) Tests deterministas

`tests/helpers/memoryAssetsStore.ts` + `tests/assets.test.ts`:
- mapLegacyStatus ambas tablas, canTransition todas las aristas (incluidas inválidas:
  draft→published directo NO, published→draft NO)
- syncAssets idempotente (2 corridas → mismo count de upserts, sin duplicar);
  status manual preservado en re-sync
- flyers con ref determinista + parent_asset_id a la nota
- transitionAsset write-through: aprueba asset → source status actualizado
- archived solo toca asset (sin legacy)
- rutas: list filtra kind/status, sync 200, transition 200/404/409
- tenant isolation
- Migración: sección PF-10 en verify-migration-pglite.mjs

## NO TOCAR

- `clips`/`publications` schemas y columnas (cero cambios en tablas existentes —
  assets es capa NUEVA encima)
- Todos los services PF-01..09 (clipCutter/Reframe/Subtitle/Recut/noteFactory/
  quoteFlyer/imageModel/networkVariant/clipRender*) — NINGUNO se modifica; el ledger
  se puebla por sync, no por hooks
- `clipService.ts`, `pipelineService.ts`, `contentMultiplierService.ts`
- El UNIQUE (tenant,source_table,ref_id) es el contrato de idempotencia — no
  improvisar claves distintas

## Gates obligatorios

```bash
npm ci --ignore-scripts   # si node_modules no está
npx drizzle-kit generate  # migración 0015
node scripts/verify-migration-pglite.mjs  # + sección PF-10
npx tsc --noEmit          # EXIT 0
npx vitest run            # 680 base + nuevos
npm run build             # verde
```

## Reporte

`DONE: PF-10 → <SHA>` + archivos + migración + gates + decisiones (ref determinista de
flyers, mapa de estados completo, por qué ledger y no merge destructivo). `BLOCKED:`.
