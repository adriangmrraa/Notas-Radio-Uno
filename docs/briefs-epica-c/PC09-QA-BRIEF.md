# PC-09 QA FINAL — read-only, contexto fresco

Revisá el commit `4d17dad` de la rama `pc-09-dossier-transmission` contra la base `0b734ab`. **Read-only**: no modifiques,
no stages, no commitees, no push, no merge, no deploy. `PC09-QA-BRIEF.md` puede quedar untracked.

## Contexto

PC-09 = **vincular el dossier de invitados a la transmisión programada**. El schema `guest_dossiers` ya existía
(`guest_id`, `tenant_id`, `program_id` NOT NULL, `guest_name`, `scheduled_date` NOT NULL, `content` jsonb, `status`).
El commit agrega `scheduled_transmission_id` (nullable, FK `set null`), migración `0010`, `src/server/lib/dossierLink.ts`
(regla de vínculo), cambios en `dossierService.ts` / `routes/guests.ts` / `ProgramsPage.tsx`, y
`tests/dossier-transmission.test.ts`.

## Qué auditar

### 1. Migración `0010`
- ¿Es **idempotente** con el patrón del repo (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, FK en
  `DO $$ ... EXCEPTION WHEN duplicate_object OR duplicate_table ... END $$;`)? Verificá **a mano** que reaplicarla
  no falla (el verificador la reaplica, pero mirá el SQL).
- ¿No altera ni borra migraciones previas? ¿El snapshot `0010_snapshot.json` y `_journal.json` quedan coherentes
  (gate de no-drift: `npm run build` dice "No schema changes")?
- ¿La columna es **nullable** y la FK es `on delete: 'set null'`? ¿`program_id` y `scheduled_date` siguen NOT NULL?
- ¿Hay índice en la FK nueva?

### 2. La regla de vínculo (`src/server/lib/dossierLink.ts`)
- Emisión de **otro tenant** ⇒ error "no encontrada" (⇒ 404), no "ajena" (⇒ 403) ni fuga de datos.
- Emisión cuyo `program_id` **no coincide** con el del invitado ⇒ 400 con mensaje claro.
- Emisión **sin** `program_id` ⇒ ¿se acepta? (el brief lo deja a tu criterio: justificá lo que el código hace).
- Sin emisión (body sin `scheduledTransmissionId`) ⇒ comportamiento **idéntico al de antes** (dossier por invitado).
- ¿La función es **pura** y testeable? ¿Los tests cubren los tres casos?

### 3. Servicio y rutas
- `generateGuestDossier(guestId, tenantId, scheduledTransmissionId?)` persiste el vínculo.
- `getLatestDossier` devuelve el vínculo + nombre de emisión + nombre de programa (join) **filtrando por tenant**.
- `listDossiers` soporta el filtro nuevo `?scheduledTransmissionId=` **además** de `programId` y `date`.
- `POST /api/guests/:id/dossier` parsea el body opcional; `GET /api/guests/:id/dossier` devuelve los campos nuevos;
  `GET /api/dossiers` acepta el filtro nuevo.
- **Aislamiento**: toda query filtra por `tenant_id` del `req.auth`; el tenant nunca viene del body. Verificá que el
  listado no devuelva filas de otro tenant (el autor dice que re-verifica `row.tenantId` en el predicado además
  del filtro SQL — verificá que eso sea correcto y no una condición imposible).

### 4. UI (`ProgramsPage.tsx`)
- El diff de `ProgramsPage.tsx` debería ser **acotado** (el brief pedía tocar lo mínimo). ¿Cuántas líneas cambió
  realmente? ¿Se rompió algo del CRUD de invitados o del pipeline?
- El `DossierPanel` recibe `programId`, lista la agenda del programa y filtra por `isActive`.
- Con dossier listo ⇒ muestra "Para: <emisión> · <fecha/hora **en su timezone>**".
- Sin entradas de agenda ⇒ el selector no renderiza y el flujo queda igual.
- Con dossier sin emisión ⇒ no aparece la línea "Para:".
- El selector incluye "(sin emisión)" y manda `scheduledTransmissionId` al generar/regenerar.
- ¿El selector de emisión manda algo que el backend entienda (nombre del campo correcto)?

### 5. Tests
- `tests/dossier-transmission.test.ts` (13 tests): ¿prueban la regla de vínculo y el aislamiento de verdad?
  ¿Qué queda sin probar (p.ej.: capa HTTP, escritura real en DB)?
- Suite completa verde (esperado: 6 files / 121 tests).

### 6. Scope
- El prompt/contenido del dossier **no** cambió (el brief lo prohibía): verificá que `runDossierGeneration` y el
  prompt de IA estén intactos.
- `drizzle/0000`..`0009` y sus snapshots no se tocaron.
- `scheduled_jobs` / `ScheduledJobsPage` / `jobSchedulerService` NO tocados. Sin dependencias nuevas.

### 7. Gates (a completion, exit code real)

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check 0b734ab..HEAD
git status --short
```

Ojo: el runner PGlite falla de forma **transitoria** con `stdin is not a tty` (ya se vio en varios slices). Si te
pasa, **re-corré** y reportá el resultado de la corrida que terminó (la 2ª/3ª dan 0).

## Salida

**GO** o **NO-GO** estricto. CRITICALS primero (archivo:línea + escenario concreto). Después warnings.
Exit codes + línea de resumen de vitest + salida del verificador PGlite. Lo no verificado, explícito.
