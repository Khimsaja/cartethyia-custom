/**
 * The migration that retires `provider_accounts.max_inflight`.
 *
 * A schema migration is the one kind of change that cannot be verified by
 * reading the code: the SQL either applies to a real database or it does not,
 * and a migration that silently no-ops leaves the column behind on every
 * deployed instance while a fresh install never creates it — the two shapes
 * diverge, which is exactly what the baseline-plus-forward-file convention
 * exists to prevent.
 *
 * So this runs the real runner (`applySqlMigrations`, the same function startup
 * calls) against a real database, with the column *present* and its ledger row
 * removed, so the migration genuinely executes instead of being skipped as
 * already-applied. It then asserts three things: the column is gone, the other
 * two `max_inflight` columns survive, and the file is recorded.
 *
 * That last assertion is what makes a re-run safe. The migration uses
 * `DROP COLUMN IF EXISTS`, so a second application is a no-op rather than an
 * error, and the ledger is what stops it being attempted twice anyway.
 */
import { afterAll, expect, test } from "bun:test";
import { applySqlMigrations } from "../../src/persistence/postgres";
import { getTestPool, dbDescribe } from "../helpers/database";

const MIGRATION_FILE = "0029_retire_per_account_max_inflight.sql";

/** Every table that still legitimately carries a `max_inflight` column. */
const SURVIVING_TABLES = ["network_pools", "provider_routing_settings"];

dbDescribe("migration: retire the per-account max_inflight", () => {
  const pool = getTestPool();

  afterAll(async () => {
    // Leave the database in the post-migration shape the rest of the suite
    // expects: the column gone and the ledger row present.
    const client = await (await pool).connect();
    try {
      await client.query(
        'ALTER TABLE "provider_accounts" DROP COLUMN IF EXISTS "max_inflight"',
      );
      await client.query(
        "INSERT INTO cartethyia_schema_migrations (migration_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [MIGRATION_FILE],
      );
    } finally {
      client.release();
    }
  });

  test("drops the column from a database that still has it", async () => {
    const client = await (await pool).connect();
    try {
      // Recreate the pre-migration shape and unrecord the file, so the runner
      // has real work to do rather than skipping it.
      await client.query(
        'ALTER TABLE "provider_accounts" ADD COLUMN IF NOT EXISTS "max_inflight" integer',
      );
      await client.query(
        "DELETE FROM cartethyia_schema_migrations WHERE migration_id = $1",
        [MIGRATION_FILE],
      );

      const present = await client.query(
        `select column_name from information_schema.columns
         where table_name = 'provider_accounts' and column_name = 'max_inflight'`,
      );
      expect(present.rows.length).toBe(1);

      await applySqlMigrations(await pool);

      const gone = await client.query(
        `select column_name from information_schema.columns
         where table_name = 'provider_accounts' and column_name = 'max_inflight'`,
      );
      expect(gone.rows.length).toBe(0);
    } finally {
      client.release();
    }
  });

  test("leaves the other concurrency ceilings in place", async () => {
    // The per-account column is dead, but concurrency is still capped — by the
    // provider-wide setting and the network-pool limit. A migration that took
    // out either of those would remove real policy.
    const client = await (await pool).connect();
    try {
      const remaining = await client.query(
        "select table_name from information_schema.columns where column_name = 'max_inflight' order by table_name",
      );
      expect(remaining.rows.map((row: { table_name: string }) => row.table_name)).toEqual(
        SURVIVING_TABLES,
      );
    } finally {
      client.release();
    }
  });

  test("records the file so a restart does not re-run it", async () => {
    const client = await (await pool).connect();
    try {
      const recorded = await client.query(
        "select migration_id from cartethyia_schema_migrations where migration_id = $1",
        [MIGRATION_FILE],
      );
      expect(recorded.rows.length).toBe(1);
    } finally {
      client.release();
    }
  });

  test("re-applying is a no-op rather than an error", async () => {
    // `DROP COLUMN IF EXISTS` is what makes a partial application recoverable.
    await applySqlMigrations(await pool);
    const client = await (await pool).connect();
    try {
      const gone = await client.query(
        `select column_name from information_schema.columns
         where table_name = 'provider_accounts' and column_name = 'max_inflight'`,
      );
      expect(gone.rows.length).toBe(0);
    } finally {
      client.release();
    }
  });
});
