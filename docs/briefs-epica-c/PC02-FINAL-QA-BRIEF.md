# PC-02 FINAL QA — read-only (contexto limpio)

Revisá el commit `7b00f65` de la rama `pc-02-conductors-persons` contra `95f112e` (base) de forma **independiente y read-only**. No modifiques archivos, no stages, no commitees, no push, no merge, no deploy.

## Alcance

PC-02: migración de conductores e invitados legacy (`conductors`, `guests`) a la biblioteca `persons` de PC-01, de forma segura, idempotente y sin cruce de tenants.

## Qué auditar

1. `drizzle/0007_rare_thena.sql`: ¿el backfill es idempotente? ¿puede duplicar personas o relaciones al reaplicarse? ¿el `tenant_id` se preserva y se valida? ¿el vínculo legacy↔person es determinista? ¿se pierde o trunca información (nombre largo, rol, bio, is_active, fechas, programa)?
2. Aislamiento multi-tenant: las relaciones `person_program` sólo deben crearse si el programa pertenece al mismo tenant que el registro legacy. Verificá que no exista ningún camino que cree una relación cross-tenant.
3. `drizzle/meta/0007_snapshot.json` + `drizzle/meta/_journal.json` + `src/server/db/schema/persons.ts`: coherencia entre el schema Drizzle y el SQL realmente aplicado (drift).
4. `scripts/verify-migration-pglite.mjs`: ¿el verificador realmente prueba lo que dice? ¿el fixture adversarial cross-tenant está bien construido (el programa del otro tenant existe y es alcanzable)? ¿los asserts son reales o triviales?
5. Scope: confirmá que NO se agregan UI, agenda/transmisiones, onboarding ni prompts (eso es PC-03/PC-05/PC-07/PC-08/PC-10).

## Gates (corridos a completion, con exit code real)

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
git diff --check 95f112e..HEAD
git status --short
```

Devolvé **GO** o **NO-GO** estricto, con los CRITICALS primero y evidencia concreta (líneas de archivo, exit codes, líneas de salida resumen). Si es NO-GO, escribí el hallazgo accionable exacto. No modifiques nada: `PC02-FINAL-QA-BRIEF.md` puede quedar untracked.
