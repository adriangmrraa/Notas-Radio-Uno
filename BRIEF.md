# PE-05 — Citas atribuidas a persona (nombre + foto)

KANBAN_TASK_ID: t_d2f3cad5
Slice de: ÉPICA E — Motor de análisis en vivo
Ejecutor: devin-swe-2-max (agente delegado en worktree Orca)
Base: 3a5d97e (master tip — incluye PE-01/02/03/06/07)

## Objetivo

Las citas ya quedan persistidas por PE-02 en `transmission_moments`
(`kind='detected'`, `reason='quote'`, `title` = texto de la cita, ventana
`start_ms/end_ms`). PE-05 las **atribuye a persona con nombre + foto** —
computed-on-read, SIN cambios de schema y SIN persistir la atribución:

> cita → utterance de `transcript_segments` que la cubre (mayor overlap, misma
> transmisión) → `speaker_label` + `person_id` → `persons` + foto primaria.

**Por qué computed-on-read**: una corrección manual de `person_id` (PE-03
`correctSpeakerPerson`) re-atribuye las citas automáticamente — si la
atribución estuviera persistida quedaría stale. El contrato "corrección
manual persiste" de PE-03 se extiende acá gratis.

## Contratos heredados (NO reimplementar)

| Pieza | Dónde | Uso |
|---|---|---|
| `transmission_moments` | `src/server/db/schema/live.ts` | citas: `kind='detected'` AND `reason='quote'`; `title` = texto, ventana `start_ms`/`end_ms`. Leer, no escribir. |
| `transcript_segments` | `live.ts` | `speaker_label`, `person_id`, `start_ms/end_ms` — PE-02 las puebla, PE-03 las resuelve. |
| `persons` + `person_photos` | `persons.ts` | `persons.name`; foto = `person_photos.is_primary` (fallback: la más antigua — **misma regla que `liveRoomService`/`faceEnrollmentService`: revisar `findPrimaryPhoto`**). |
| photoUrl | `liveRoomService.ts` | formato ya establecido: `/api/persons/${personId}/photos/${photoId}` — replicar el mismo path (la ruta GET existe en `routes/persons.ts`). |
| Offsets | convención repo | `start_ms`/`end_ms` relativos a `transmissions.started_at` — misma convención para matching temporal. |

## Arquitectura pedida (patrón del repo)

`src/server/services/attributedQuotesService.ts`:

- `AttributedQuotesStore` + `createDrizzleAttributedQuotesStore` + `createAttributedQuotesService(store)`.
- Store (TODA query con `tenant_id`):
  - `listQuoteMoments(tenantId, transmissionId)` → moments `reason='quote'` ordenados por `start_ms`.
  - `listUtterances(tenantId, transmissionId)` → transcript_segments ordenados (o un overlap query por ventana si preferís menos datos — decidir por claridad).
  - `listPersonsPhotos(tenantId, personIds[])` → `{personId, name, primaryPhotoId}` — una query, foto primaria o más antigua como fallback.
- Servicio: `listAttributedQuotes(tenantId, transmissionId)` → `AttributedQuote[]`:
  `{ momentId, text, startMs, endMs, speakerLabel, personId, personName, personPhotoUrl, attribution: 'person' | 'speaker' | 'unattributed' }`
  - utterance elegida = la de MAYOR overlap temporal con la ventana de la cita (empate → la que contiene el punto medio).
  - `attribution='person'` cuando hay personId; `'speaker'` cuando sólo hay speaker_label; `'unattributed'` sin utterance.
  - Devolver también `score`/`reason` del momento si aplica (el momento es detected).
- Sin endpoints ni socket — la Sala/UI lo consume cuando corresponda.

## Tests (`tests/attributedQuotes.test.ts` + `tests/helpers/memoryAttributedQuotesStore.ts`)

Deterministas:
- cita con utterance que la cubre y person_id resuelto → `attribution='person'` con name + photoUrl correcto
- utterance sin person_id → `attribution='speaker'` con speakerLabel
- cita sin utterance solapada → `attribution='unattributed'`
- mayor overlap gana cuando hay 2 utterances candidatas
- persona sin foto primaria → fallback a más antigua (o null si no hay fotos)
- aislamiento por tenant

## Constraints

- `tenant_id` en TODA query. NO schema changes. NO persistir atribución.
- NO tocar: `liveRoomService.ts`, `personIdentityService.ts`, `analysisEngineService.ts`, `transmissionSegmentsService.ts`, schemas.

## Gates

`npx tsc --noEmit` EXIT 0 · `npx vitest run` verde · `npm run build` verde.
`npm ci --ignore-scripts` primero si no hay node_modules.
Commit conventional en `pe-05-attributed-quotes`, paths explícitos, sin atribución IA. NO push, NO PR.
