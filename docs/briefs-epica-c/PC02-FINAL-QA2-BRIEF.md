# PC-02 FINAL QA #2 — read-only sobre el commit `30e34d7`

Contexto limpio. Revisá el commit `30e34d7` de la rama `pc-02-conductors-persons` contra la base `95f112e`. **Read-only**: no modifiques archivos, no stages, no commitees, no push, no merge, no deploy.

Contexto: la slice PC-02 ya tuvo un GO previo sobre `7b00f65` y luego un repair (`30e34d7`) que cerró dos warnings no bloqueantes:

- **W1** `person_program.role_on_program` es `varchar(80)` y el rol legacy es `varchar(100)` → se aplicó truncamiento explícito `LEFT(BTRIM(...), 80)` en ambos INSERT de `person_program`, conservando el rol crudo completo en `persons.role_label` (`varchar(120)`).
- **W2** faltaba fixture adversarial cross-tenant de `guests` → se agregó (invitado de tenant 1 con `program_id` de un programa de tenant 2) más un fixture de rol de 100 caracteres.

## Qué auditar

1. `drizzle/0007_rare_thena.sql` completo: idempotencia real (aplicar dos veces no duplica), determinismo del vínculo legacy↔person, preservación de datos (nombre hasta 255, `role_label` crudo, `bio`, `is_active`, fechas), ausencia de pérdida y ausencia de cualquier ruta cross-tenant.
2. El truncamiento de W1: ¿es determinista? ¿`role_label` conserva el valor original completo? ¿se puede perder información relevante?
3. `scripts/verify-migration-pglite.mjs`: ¿los asserts nuevos son reales y no triviales? ¿el fixture de `guests` cross-tenant es alcanzable y pertenece a otro tenant? ¿el fixture de rol largo prueba el truncado?
4. Coherencia schema↔SQL: `src/server/db/schema/persons.ts`, `drizzle/meta/0007_snapshot.json`, `drizzle/meta/_journal.json` (drift).
5. Scope: sólo PC-02. Nada de UI, agenda/transmisiones, onboarding ni prompts.

## Gates (a completion, con exit code real)

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
git diff --check 95f112e..HEAD
git status --short
```

Devolvé **GO** o **NO-GO** estricto: CRITICALS primero, con líneas de archivo y exit codes. Si NO-GO, el hallazgo accionable exacto. `PC02-FINAL-QA2-BRIEF.md` puede quedar untracked.
