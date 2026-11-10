# Fresh final QA — PeriodistApp Épica C / PC-01

You are a fresh, read-only reviewer. Do not edit, stage, commit, push, merge, deploy, apply production migrations, or remove files.

## Review target
- Worktree: `C:/Users/Asus/orca/workspaces/periodistapp/epica-c-context`
- Baseline: `origin/master` / `aabf707`
- Candidate: `95f112e feat(contexto): PC-01 schema persons, face embeddings y perfiles editoriales`
- Scope brief: `PC01-SCOPE-REPAIR-BRIEF.md`

## Acceptance
Review candidate scope and implementation only:
- PC-01 includes only tenant-scoped `persons`, `person_photos`, `face_embeddings`, `person_program`, and `editorial_profiles`, plus essential non-breaking conductor/guest bridges.
- No PC-02 data migration, no PC-07 transmissions/agenda schema, and no PC-10 onboarding state.
- New foreign keys are indexed; schema/migration/journal/snapshot agree.
- Every new multi-tenant entity uses `tenant_id`; validate migration idempotency and pgvector SQL plausibility.

## Gates — run on candidate tree; capture exact exits and summaries
1. `npx tsc --noEmit`
2. `npm run build`
3. `node scripts/verify-migration-pglite.mjs` (must prove 0006 reapplies idempotently)
4. `git diff --check origin/master..95f112e`

The existing untracked brief files and `remotion/package-lock.json` are unrelated residuals; do not treat them as candidate source changes.

Return strict `GO` or `NO-GO`, concrete file:line findings, command exits, and whether auto-FF `epica-c-context -> master` is safe. No invention.
