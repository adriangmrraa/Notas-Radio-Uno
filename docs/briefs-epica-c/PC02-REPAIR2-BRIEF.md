# PC-02 Repair #2 — warnings no bloqueantes del QA final

El QA final dio **GO** sobre `7b00f65`, con dos warnings no bloqueantes. Como son baratas de cerrar y evitan un fallo real en datos adversarios, las arreglamos ahora, dentro del mismo slice PC-02.

## W1 — `role_on_program` puede abortar la migración

`person_program.role_on_program` es `varchar(80)` y el `role` legacy de `conductors`/`guests` es `varchar(100)`: un rol de 81–100 caracteres hace fallar el INSERT y aborta toda la migración (fail-safe, pero bloquearía un deploy).

Elegí **una** de estas dos y justificá en el reporte cuál:

- (a) truncar de forma explícita y determinista en el INSERT (`LEFT(BTRIM(...), 80)`), o
- (b) ensanchar `person_program.role_on_program` a 255 en el schema + migración, si eso no genera drift con `0006` (el build tiene que seguir diciendo "No schema changes").

Preferí (a) salvo que (b) sea trivial y limpio.

## W2 — falta fixture adversarial de `guests` cross-tenant

El verificador prueba el caso cross-tenant sólo con `conductors`. Agregá el caso equivalente para `guests` (invitado de tenant 1 cuyo `program_id` apunta a un programa de tenant 2) y el assert de cero `person_program` cross-tenant. Ojo: `guests.program_id` es `NOT NULL`, así que el fixture debe usar un programa existente de otro tenant.

## Gates (a completion, con exit code real)

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
git diff --check
git status --short
```

Enmendá el commit `7b00f65` (mismo slice, conventional commit, paths explícitos). No push, no merge, no deploy. Reportá el SHA nuevo, qué opción elegiste para W1 y los exit codes.
