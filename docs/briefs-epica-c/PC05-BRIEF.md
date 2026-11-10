# PC-05 — Línea editorial (UI): tono, reglas, ejemplos, rubro, formatos activos — tenant + override por programa

Ejecutá este brief **end to end, de forma autónoma**. Nunca esperes aprobación. Si algo del brief es imposible,
NO lo simules: dejalo sin hacer, explicá por qué en el reporte y seguí con el resto.

## Contexto real (verificado)

- Repo `periodistapp`: **Express 4 + TypeScript (API) + React SPA (Vite) + Drizzle/Postgres**.
- Base: `origin/master` @ `e6c0757` (PC-01 schema, PC-02 datos, PC-03 CRUD Personas, PC-04 pipeline de rostros).
- **El schema YA EXISTE — NO hay que crear migración.** `src/server/db/schema/editorialProfiles.ts`:
  tabla `editorial_profiles` con:
  - `id`, `tenant_id` (FK tenants, NOT NULL), `program_id` (FK programs, **nullable**),
  - `name` (varchar 120), `tone` (varchar 40, NOT NULL, default `'formal'`), `tone_description` (text),
    `style_guide` (text), `rules` (**jsonb**, default `[]`), `examples` (**jsonb**, default `[]`),
    `industry` (varchar 80), `active_formats` (**jsonb**, default `[]`), `forbidden_topics` (**jsonb**, default `[]`),
    `signature` (text), `is_active` (bool, default true), `created_at`, `updated_at`.
  - Índices: `uniqueIndex('editorial_profiles_tenant_program_unique').on(tenantId, programId)` +
    `uniqueIndex('editorial_profiles_tenant_default_unique').on(tenantId).where(programId is null)`.
  - **Semántica del schema (importante)**: `program_id = null` ⇒ perfil **default del tenant**. `program_id` no nula ⇒
    **override de ese programa**. Una fila por (tenant, programa).
- Formato de los jsonb (según el comentario del schema): `rules: string[]` (ej. "Nunca nombrar menores"),
  `examples: [{ title, excerpt }]`, `active_formats: string[]` (ej. "flash", "corta", "completa", "cronica", "twitter"),
  `forbidden_topics: string[]`.
- **NO existe todavía** `editorialService`/`routes/editorial` ni UI de editorial en master (verificado: sólo el schema).
- Hay una implementación de referencia en la rama `gurnard` de este mismo repo:
  `C:/Users/Asus/orca/workspaces/periodistapp/gurnard/src/server/services/editorialProfileService.ts`
  (resolución perfil efectivo tenant→programa, merge por campo). **Leela y adaptá** — pero OJO: ese schema de
  `gurnard` es **distinto** (`editorialProfiles` con `toneExamples`, `rubro`, `audience`, `approvalPolicy`,
  `version` + tabla `editorial_profile_versions`). **El schema que manda es el de `master`**
  (`editorialProfiles.ts` que acabo de describir). Usá `gurnard` sólo como referencia de **patrón de código**
  (merge por campo, resolución, detección de campos overrideados), no de columnas.

## Qué hay que construir

### 1. `src/server/services/editorialService.ts` (nuevo) — resolución del perfil efectivo

API pública mínima (adaptá nombres si el repo sugiere otro estilo, pero mantené estos conceptos):

- `getTenantProfile(tenantId): Promise<EditorialProfileRow | null>` → la fila con `program_id IS NULL`.
- `getProgramProfile(tenantId, programId): Promise<EditorialProfileRow | null>` → la fila de ese programa
  (**verificá que el `program_id` pertenezca al tenant** antes de leer/escribir).
- `getEffectiveProfile(tenantId, programId?): Promise<EffectiveEditorialProfile>` — **resuelve y mergea**:
  1. base = perfil default del tenant; si no existe ⇒ `DEFAULT_EDITORIAL_PROFILE` (tono `'formal'`, resto vacío).
  2. si hay `programId` y existe fila de override para ese programa ⇒ **merge por campo**: el override pisa
     **sólo los campos que define** (no-nulos / no-vacíos según el tipo); los campos que el override **no** define
     los hereda del perfil del tenant.
  3. Devuelve el shape final + `sources: { hasTenantProfile: boolean, overriddenFields: string[] }`
     (qué campos Effectively vienen del override — útil para la UI y para testear).
- **Regla de merge (decidíla así, aplicala)**: campo por campo —
  - escalares (`tone`, `name`, `industry`, `signature`, `toneDescription`, `styleGuide`): el override gana si **no es null**
    (para `tone`, que es NOT NULL con default `'formal'`, el override gana siempre si la fila de override existe —
    documentá esaexception en el código).
  - arrays jsonb (`rules`, `activeFormats`, `forbiddenTopics`): el override gana si el array **tiene al menos 1 elemento**;
    si el override tiene el array **vacío**, se hereda el del tenant (así un override puede no pisar las reglas).
  - `examples` (array de objetos): el override gana si tiene al menos 1 elemento; si está vacío, se hereda.
- `DEFAULT_EDITORIAL_PROFILE` exportado, con el mismo shape.
- **Todo filtrado por `tenant_id`**. Nunca mezques perfiles de otro tenant.

### 2. `src/server/routes/editorial.ts` (nuevo) — API de la línea editorial

Router con `requireAuth` en todas las rutas (patrón de `src/server/routes/persons.ts`: `req.auth!.tenantId`,
`and(eq(...id), eq(...tenantId))`, 404 para ids ajenos):

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/editorial/profile` | Devuelve el **perfil efectivo** del tenant + el **perfil default del tenant** (fila cruda) + los overrides por programa (resumen: `programId`, `programName`, campos definidos). Query opcional `?programId=` para el efectivo de ese programa. |
| PUT | `/api/editorial/profile` | **Upsert del perfil default del tenant** (`program_id = null`). Body: `{ name?, tone, toneDescription?, styleGuide?, rules?, examples?, industry?, activeFormats?, forbiddenTopics?, signature?, isActive? }`. Valida: `tone` ∈ {`formal`,`informal`,`urgente`,`analitico`,`custom`}; `rules`/`activeFormats`/`forbiddenTopics` = array de strings; `examples` = array de `{title, excerpt}`; strings con largo razonable. Respuesta: la fila guardada. |
| PUT | `/api/editorial/profile/:programId` | **Upsert del override de un programa**. Mismo body + validación. `programId` debe existir y ser del tenant ⇒ si no, **404**. |
| DELETE | `/api/editorial/profile/:programId` | Borra el override de ese programa (no el default del tenant). 404 si no existe o es de otro tenant. |
| GET | `/api/editorial/programs` | Lista los programas del tenant (id + nombre) para que la UI pueda elegir programa. |

- Montá el router en `src/server/index.ts` (`app.use("/api/editorial", editorialRouter)`), siguiendo el patrón del repo.
- `requireActiveSubscription` si el repo lo aplica a features de escritura (mirá cómo está en otros routers) — no
  inventes una gate nueva.

### 3. UI — página de línea editorial

- Nueva página `src/client/pages/EditorialPage.tsx` + ruta `/editorial` en `src/client/main.tsx`
  (dentro del bloque `PrivateRoute` + `Layout`) + ítem de navegación en
  `src/client/components/Sidebar.tsx` → `NAV_MAIN` (icono de lucide-react, ej. `Newspaper`/`PenLine`).
  OJO: `NAV_MAIN` está en **`src/client/components/Sidebar.tsx`** (no en `Layout.tsx`).
- La página debe permitir, de punta a punta:
  1. **Ver y editar el perfil default del tenant**: tono (select), nombre, descripción del tono, guide de estilo,
     reglas (lista editable: agregar/quitar texto), ejemplos (lista editable: título + extracto), rubro,
     formatos activos (checkbox/list de: `flash`, `corta`, `completa`, `cronica`, `twitter`, `linkedin`,
     `instagram`, `youtube`, `newsletter` — las opciones exactas son las de `active_formats`, no inventes),
     temas prohibidos (lista editable), firma, activo/inactivo.
  2. **Ver los overrides por programa** y **editar el override de un programa** (mismo formulario, con la
     información de qué campos heredan del default del tenant).
  3. **Resetear un override** (borrarlo ⇒ vuelve a heredar del default).
  4. Mostrar de forma clara **qué campos viene del tenant y cuáles del override** (usá `sources.overriddenFields`).
- Usá `useApi()` de `src/client/hooks/useApi.ts` (prefix `/api`, Bearer + credentials). Nada de `fetch` pelado.
- Estado de carga, estado vacío honesto y mensajes de error visibles. **Nada de datos inventados.**
- Usá los componentes/estilos que ya existen en `src/client/components/ui/`. No instales dependencias nuevas.

### 4. Tests (obligatorios — el repo ya tiene vitest desde PC-04)

`npx vitest run` debe quedar verde. Agregá tests del **servicio de resolución** (sin DB): con un store inyectable
o con el `db` mockeado, cubriendo:
- tenant sin perfil ⇒ `DEFAULT_EDITORIAL_PROFILE`.
- tenant con perfil, sin `programId` ⇒ devuelve el perfil del tenant.
- override de programa: los campos definidos pisan, los no definidos se heredan del tenant.
- `rules`/`activeFormats`/`examples` vacíos en el override ⇒ heredan (no pisan con vacío).
- `sources.overriddenFields` lista exactamente los campos pisados.
- **aislamiento**: un `programId` de otro tenant no se resuelve (ni se lee su perfil).
Si el repo no tiene una forma cómoda de testear el servicio sin DB, hacé que la función de merge sea **pura**
(`mergeEditorialProfile(base, override): { profile, overriddenFields }`) y testeala así — es lo más simple y no
requiere infrastructure.

### 5. Verificación (exit code real)

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check
git status --short
```

`npm run build` debe seguir imprimiendo **"No schema changes, nothing to migrate"** (si genera migración, hay drift:
revisá que no hayas tocado el schema).

## Fuera de scope (NO lo implementes)

- **PC-06** (inyectar el perfil en los prompts de generación) — es el slice siguiente, no este. **NO toques**
  `src/server/services/newsService.ts`, `contentMultiplierService.ts`, `insightService.ts`, `clipService.ts`,
  `alertService.ts` ni `pipelineService.ts`.
- Transmisiones / agenda / RRULE (PC-07/PC-08), dossier (PC-09), onboarding (PC-10), búsqueda por similitud de rostros.
- No agregues columnas/tablas/migraciones. **NO toques** `drizzle/`, `drizzle/meta/` ni `src/server/db/schema/`.
- No instales dependencias nuevas (vitest y onnxruntime-node ya están).

## Límites duros

- **NO push**, **NO merge** a master, **NO deploy**.
- **NO toques** el checkout compartido `C:/Users/Asus/Documents/estabilizacion/periodistapp`: todo en este worktree.
- **NO uses `git add -A` ni `git add .`**: commit con **paths explícitos**.
- Commit **conventional** (`feat(editorial): ...`), **sin atribución de IA**, sin `Co-Authored-By`.
- No borres ni reescribas untracked preexistentes (`remotion/package-lock.json`, etc.).
- Si algo es imposible, no lo simules: explicá por qué en el reporte y seguí con el resto.

## Reporte final (obligatorio)

1. SHA del commit + `git show --stat`.
2. Exit code de **cada** gate + la línea de resumen de vitest (`Test Files ... Tests ...`).
3. Endpoints creados (método + ruta + código de estado) y rutas de UI agregadas.
4. La **regla de merge** que implementaste, campo por campo, con un ejemplo concreto (override que pisa 2 campos y
   hereda 3).
5. Cómo se comprueba el aislamiento multi-tenant (qué query filtra por tenant y qué devuelve un id ajeno).
6. Qué quedó fuera y por qué.
