# PC-04 QA FINAL — read-only, contexto fresco

Revisá el commit `e6c0757` de la rama `pc-04-face-pipeline` contra la base `aa9fa24`. **Read-only**:
no modifiques archivos, no stages, no commitees, no push, no merge, no deploy. `PC04-QA-BRIEF.md` puede quedar untracked.

## Contexto

PC-04 = **pipeline de rostros**: subir foto → detectar cara → embedding → guardar. El schema ya existía
(`face_embeddings.embedding vector(512)` pgvector, `person_photos.face_detected/face_count`, `persons.face_status/embedding_ref/consent_*`).
El commit agrega: `src/server/services/faceDetectionService.ts` (SCRFD+ArcFace vía `onnxruntime-node`, modelos
`buffalo_l` lazy en `.cache/face-models/`, gitignored), `faceEnrollmentService.ts` (pipeline + `FaceStore` inyectable),
`faceModels.ts`, `scripts/download-face-models.ts`, rutas nuevas en `src/server/routes/persons.ts`, UI en
`PersonsPage.tsx`, `tests/face-enrollment.test.ts` (14 tests) + `tests/helpers/memoryFaceStore.ts`, y
`onnxruntime-node` + `vitest` como devDependencies.

**AC del slice**: una foto SIN cara se rechaza con mensaje claro y explícito; una foto CON cara genera embedding de
512 dims persistido, `face_detected=true` y `face_count` correcto.

## Qué auditar

### 1. El AC (lo principal)
- Ruta de enrolamiento: ¿qué código de respuesta y **qué mensaje literal** devuelve cuando el detector ve **0 caras**?
  ¿Y cuando ve **>1**? Mismo para el **503** (detector no disponible): el cliente tiene que poder distinguir
  "no hay cara" de "no puedo detectar" — un 200 silencioso con `face_detected=false` sería un CRITICAL.
- Con **1** cara: ¿persiste el embedding con **512 dimensiones** en `face_embeddings` (`tenant_id`, `person_id`,
  `person_photo_id`, `model`, `dimensions=512`)? ¿Actualiza `person_photos.face_detected=true` y `face_count=1`?
  ¿Setea `persons.embedding_ref` y `persons.face_status='enrolled'`? ¿Y `consent_given/consent_at`?
- **Consentimiento**: ¿se puede enrolar sin consentimiento? ¿qué mensaje da? ¿el consent queda registrado?
- **Un embedding por foto**: re-enrolar la misma foto ¿deja dos embeddings vivos para el mismo `person_photo_id`?
- Desenrolar: ¿borra el embedding, limpia `embedding_ref`, vuelve `face_status='pending'`?

### 2. Aislamiento multi-tenant
- Recorré `faceEnrollmentService.ts` y las rutas nuevas de `persons.ts`: ¿**cada** query filtra por `tenant_id`?
  ¿`findPerson`/`findPhoto` filtran por tenant **y** por id? Un `personId`/`photoId` de otro tenant → **404** y
  **cero escrituras**.
- ¿El `tenant_id` puede venir del body? No.
- ¿La UI o el servicio de rostros puede filtrar datos de otro tenant?

### 3. El detector real (no te fíes del auto-reporte)
- `faceDetectionService.ts`: ¿el preprocesado es correcto (letterbox/det_scale, normalización ArcFace
  `(x−127.5)/127.5`, umbrales, NMS)? ¿el modelo se carga **lazy** y **no rompe el import** del módulo si falta?
- ¿Los modelos se descargan en runtime (no en build) y quedan **fuera de git** (`.gitignore` cubre `.cache/`)?
  ¿El zip/`.onnx` NO está commiteado? Verificá con `git ls-files` que no haya binarios.
- ¿`npm run build` sigue funcionando **sin** los modelos descargados?
- El agente reportó que corrió el detector real contra `t1.jpg` (6 caras) y `Tom_Hanks_54745.png` (0 caras).
  **Verificalo vos** si podés (los modelos están en `.cache/face-models/`); si no, decilo como **no verificado**.
  Ojo: el crop 112×112 que da 0 caras es comportamiento de SCRFD, no un bug.

### 4. Tests: ¿prueban algo real?
- `tests/face-enrollment.test.ts` corre contra un `FaceStore` **en memoria**, no contra la DB. **Auditalo**: ¿los
  asserts del store en memoria reflejan de verdad las queries drizzle de `createDrizzleFaceStore`? ¿hay algún test
  que ejercite la ruta HTTP real (código de estado + mensaje)?
- ¿Qué queda **sin** probar? Enumerá los huecos con nombre de archivo y qué NO se cubre. Si el hueco es grave
  (ej.: el SQL de insert del vector no está probado contra Postgres), marcalo como CRITICAL o warning explícito.

### 5. Scope y deriva
- `drizzle/` y `src/server/db/schema/` **NO** tocados.
- NO hay matching/búsqueda por similitud (otra épica), NO hay línea editorial, transmisiones, dossier ni onboarding.
- `package.json`: ¿las 2 deps nuevas (`onnxruntime-node`, `vitest`) están justificadas y son **devDependencies**?
  ¿`onnxruntime-node` como devDependency rompe el runtime en producción si el server lo importa? **Verificá** en qué
  sección quedó y si el server importa ese módulo en runtime (si queda en `dependencies`, bien; si quedó en
  `devDependencies` pero el server lo importa, es un CRITICAL de deploy).
- Sin caracteres corruptos (`grep -n '⬦\|�'`).

### 6. Gates (a completion, exit code real)

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check aa9fa24..HEAD
git status --short
```

## Salida

**GO** o **NO-GO** estricto. CRITICALS primero (archivo:línea + escenario concreto). Después warnings.
Exit codes de los gates + la línea de resumen de vitest (`Test Files ... Tests ...`). Si algo no lo pudiste
verificar, decilo explícitamente como **"no verificado"** en vez de darlo por bueno.
