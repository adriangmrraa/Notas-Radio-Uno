# PeriodistApp — ÉPICA C / PC-01 rescue

## Scope: PC-01 only
Resume the abandoned partial implementation already present in this worktree. Do not discard or overwrite the existing dirty schema changes blindly. Inspect them first and complete **only** PC-01.

Implement the tenant-scoped schema foundation for channel context:
- Physical names mandated by the SDD: `persons`, `person_photos`, `face_embeddings`, `person_program`, `editorial_profiles`.
- Use `tenant_id` consistently in every multi-tenant table and retain/extend RLS-safe application patterns.
- Unify conductor/guest identity around `persons` without breaking existing imports or current billing work.
- Add a deterministic, idempotent Drizzle migration, including the required pgvector support for face embeddings where the existing project conventions permit it.
- Do not implement PC-02 onward, UI, face-processing, integrations, push, merge, deploy, or production migrations.

## Existing state to preserve
This worktree is on `aabf707` and has uncommitted partial edits in schema files plus two new schema files. Those artifacts may be a valid start. Assess and repair them instead of starting over. `remotion/package-lock.json` is unrelated unless the diff proves otherwise: do not include it in your commit.

## Acceptance gates
1. Inspect the migration/schema against current Drizzle conventions before editing.
2. Run `npx tsc --noEmit` and `npm run build`; capture actual exit codes.
3. Run the focused migration/schema verification available in this repo; if no legitimate runner exists, explain that fact precisely rather than inventing a pass.
4. `git diff --check` clean and `git status --porcelain` clean after the commit except for this brief file and unrelated `remotion/package-lock.json`.
5. Commit only PC-01 source/migration/test files with explicit paths and a conventional message. No AI attribution.

## Final report
Report changed files, migration name, exact gate exits/test counts, commit SHA, and any residual unrelated files left untouched.
