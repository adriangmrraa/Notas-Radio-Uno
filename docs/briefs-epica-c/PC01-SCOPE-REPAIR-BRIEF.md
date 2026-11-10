# PC-01 scope repair — PeriodistApp Épica C

## Context
Commit `56d0e6b` passed `npx tsc --noEmit`, `npm run build` and `node scripts/verify-migration-pglite.mjs`, but fresh QA rejected it for scope expansion. It included schema for PC-07 / PC-10, which are deliberately separate future checklist items.

## Your one task
Repair **only PC-01** in this existing worktree. No new worktree, no push, no merge, no deploy, no production migration.

### Retain / implement for PC-01 only
- Canonical multi-tenant identity schema: `persons`, `person_photos`, `face_embeddings` (pgvector if supported), `person_program`, `editorial_profiles`.
- Required tenant scoping, foreign keys, RLS-safe schema conventions, and indexes for all newly introduced foreign-key columns.
- Drizzle migration/snapshot/journal and the PGlite migration verifier, correctly updated and idempotent.
- Existing schema relationships strictly necessary for those entities to compile and be verifiable.

### Must remove from this PC-01 commit
- `transmissions` and `scheduled_transmissions` schema/tables and all migration, export, enum, verifier or bridge code that exists only for them (reserved for PC-07).
- Onboarding-completion state/schema (reserved for PC-10).
- Any agenda-specific bridge/relationship not strictly required for canonical persons/editorial-profile schema.
- Any PC-02 data migration of existing conductors/guests; PC-02 is explicitly future work.

### Git discipline
- The branch is local and unpushed. Replace/amend `56d0e6b` into a clean PC-01-only conventional commit (do not retain out-of-scope functionality in a second commit).
- Never stage/commit `EPICA-C-PC01-BRIEF.md`, `REVIEW-BRIEF.md`, `PC01-SCOPE-REPAIR-BRIEF.md`, or `remotion/package-lock.json`.
- Use explicit paths only. Do not use `git add -A` or `git add .`.

### Verification required
Run and report actual exit codes for:
1. `npx tsc --noEmit`
2. `npm run build`
3. `node scripts/verify-migration-pglite.mjs` (including migration 0006 re-application/idempotency)
4. `git diff --check`

Do not claim completion without a new/amended commit and all gates green. If an invariant makes the requested scope impossible, stop and explain exactly why; do not expand scope silently.
