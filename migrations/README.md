# Database baselines

Cartethyia keeps one SQL baseline per database backend:

- `full-postgres/0000_baseline.sql` defines the complete PostgreSQL schema.
- `lite-sqlite3/0000_baseline.sql` is generated from the PostgreSQL baseline by
  `scripts/generate/sqlite-ddl.ts`; do not edit it by hand.

Both directories must contain only `0000_baseline.sql`. The startup runner
applies that file to an empty database and records it in
`cartethyia_schema_migrations` along with a hash marker for the exact baseline
contents. There is no in-place upgrade path for a database
with retired migration history. Startup fails with a recovery instruction
instead of treating an old schema as current.

## Recovering an existing installation

1. Export a backup from the existing installation before switching it to the
   baseline-only release.
2. Create a fresh database and point the application at it.
3. Start the application so it creates the baseline schema.
4. Restore the backup through the console restore flow.

Restore normalizes legacy values that no longer satisfy current constraints,
including `bypass_proxy` → `skip_proxy`, `bridge` → `https`, the retired
provider User-Agent default, Cline's skip-proxy default, and `fusion` →
`fallback`. Unknown or retired columns are reported and skipped according to
the backup contract.

Do not point tests or recovery steps at development or production databases.
The startup path runs `ensureMigrated()` before provider/catalog seeding. Full
mode uses `src/persistence/db-pg.ts` and an advisory lock; Lite uses
`src/persistence/db-sqlite.ts`. Readiness compares the ledger to the single
baseline file. A failed baseline aborts startup and is not recorded.

Migrations are package assets, not resolved from the process working directory:
`src/config/package-paths.ts` resolves them from the package root. `package.json`
includes `migrations/` in the published files, and the Dockerfile copies both
baselines into `/app/migrations`.

## Next schema change

1. Update `src/persistence/schema.ts` and
   `migrations/full-postgres/0000_baseline.sql` together.
2. Regenerate the Lite baseline with
   `bun scripts/generate/sqlite-ddl.ts`.
3. Update backup validation/mapping when old exported rows need normalization or
   new required values.
4. Keep each migrations directory to the single baseline. Do not add numbered
   forward migrations; existing installations recover through backup/restore.
5. Run focused baseline, restore, and typecheck tests. Validate against an
   isolated database only.
