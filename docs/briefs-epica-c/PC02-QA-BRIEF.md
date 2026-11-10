# PC-02 Fresh QA — read-only

Review commit `f45b280` against `origin/master` independently. Do not modify, stage, commit, push, merge, deploy, or delete files.

Scope: legacy conductors and guests must be migrated safely and idempotently to `persons`, preserving tenant isolation and avoiding duplicates. Confirm the migration uses actual legacy schema relationships, has deterministic links, and does not add UI/agenda/onboarding scope.

Audit `drizzle/0007_rare_thena.sql`, the Drizzle metadata, `src/server/db/schema/persons.ts`, and `scripts/verify-migration-pglite.mjs`. Check the anti-duplication logic and multi-tenant isolation. Run these gates to completion and record their actual exit codes and summary lines:

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
git diff --check origin/master..HEAD
```

Return a strict `GO` or `NO-GO`, listing critical findings first. Leave the worktree unchanged; `PC02-QA-BRIEF.md` may remain untracked.