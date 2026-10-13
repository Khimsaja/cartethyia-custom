---
name: cartethyia-schema-telemetry
description: "Schema and telemetry changes: update the canonical schema and generated baselines, restore mappings, or add a usage/telemetry field. Use for database baselines, telemetry_events/usage_totals, and combo-strategy renames."
---

# Schema and telemetry

Use for a schema change, a baseline update, or a new usage/telemetry field.

## Schema changes

The repository ships one baseline per backend; do not add numbered forward
migrations. Databases with retired migration history are rebuilt and restored
from backup, not upgraded in place.

1. Update `src/persistence/schema.ts`.
2. Update `migrations/full-postgres/0000_baseline.sql` to describe the complete
   current schema.
3. Regenerate the SQLite baseline: `bun scripts/generate/sqlite-ddl.ts`. It
   derives `migrations/lite-sqlite3/0000_baseline.sql` from the PostgreSQL
   baseline, and `test/persistence/sqlite-baseline.test.ts` fails when the two
   disagree. Do not edit the SQLite baseline by hand.
4. Update backup validation and restore mapping for old column names, enum
   values, defaults, or required data that must survive recreation.
5. Keep both migrations directories limited to `0000_baseline.sql`, and test
   the fresh schema plus legacy backup restoration. Never test against a live
   development or production database.

Drizzle numeric columns may require string persistence. Use bigint number mode
for absolute epoch milliseconds. Manual migrations are not applied by the boot
ledger; report them separately.

## Persisted telemetry fields

Per-request events are hourly JSONL under `./data/telemetry-events`
(`src/observability/event-log.ts`). The database keeps aggregates in
`telemetry_usage_totals` only; do not add a reader back onto `telemetry_events`.
Payload capture stays a separate append-only file under
`data/telemetry-payloads/`.

A new usage field must pass through canonical usage, normalization, the file
writer, console contract/store, dashboard validator, and Usage UI. Reject invalid
upstream values; do not silently clamp them. An aggregate that must survive
retention also needs the schema and both baselines. Update restore mapping when
old backups do not carry the field or use a retired representation.

## Renames and strategy removal

Change the canonical enum/model, router, console contract/store, validation,
catalog snapshot, schema, both baselines, backup mapping, dashboard
contract/hook/card, and docs. No alias fields.

Combo strategies are `fallback` and `round_robin`. There is no fusion strategy
and no minimum-balance floor: do not reintroduce
`model_combo_strategy.fusion`, `credit_limit`, or the account remaining-balance
stamps. The fresh baseline must exclude retired enum values; normalize legacy
backup rows to the current strategy during restore.

## Verify

The gate list is `cartethyia-engineering/references/verification.md`; run those,
plus `bun run test:backend`.

The boundary specific to this skill is the database: exercise the fresh
baseline and legacy backup mappings. Never reset production data — use the
disposable database configured with `CARTETHYIA_TEST_DATABASE_URL` in the local
`.env` or shell (`bun run test-db:up/check/down`).
