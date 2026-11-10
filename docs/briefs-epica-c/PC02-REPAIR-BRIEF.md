# PC-02 Repair — cerrar NO-GO de aislamiento multi-tenant

El QA independiente rechazó `f45b280` por este hallazgo crítico: `drizzle/0007_rare_thena.sql` inserta en `person_program` con el tenant del conductor/invitado sin demostrar que `program_id` pertenezca al mismo tenant. Eso permitiría propagar una relación legacy inconsistente a través de tenants.

## Reparación estricta

1. Modificá la migración para insertar `person_program` **sólo** cuando el programa exista y `programs.tenant_id = legacy.tenant_id`. Usá el join/condición SQL apropiado a los nombres físicos reales.
2. Extendé `scripts/verify-migration-pglite.mjs` con un fixture adversarial: conductor o guest cuyo `program_id` apunta a un programa de otro tenant. Después de migrar, confirmá que no existe `person_program` cross-tenant para ese registro, sin romper la migración de las asociaciones válidas.
3. Mantené idempotencia, no dupliques personas ni relaciones y no amplíes scope fuera de PC-02.
4. Corré de nuevo `npx tsc --noEmit`, `npm run build`, `node scripts/verify-migration-pglite.mjs`, `git diff --check` y hacé `git status --short`.
5. Enmendá el commit existente `f45b280` (mismo slice; conventional commit; paths explícitos). No push, no merge, no deploy.

Al final devolvé el SHA nuevo, los gates con exit code y cómo quedó probado el caso cross-tenant.