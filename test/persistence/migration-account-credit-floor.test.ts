/**
 * Migration test: per-account credit floor cutover.
 *
 * `provider_accounts` gains `min_credit_balance` / `last_remaining_credit`;
 * `provider_routing_settings.credit_floor` is backfilled onto the provider's
 * accounts and dropped. Fresh installs never create it (baseline).
 *
 * The SQL is read from the tracked file rather than restated, so the test
 * cannot drift from what a deployment actually runs. Applied inside a
 * transaction that is always rolled back, so the shared test database (and its
 * migration ledger) is untouched.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dbDescribe, withRollback } from "../helpers/database";

const MIGRATION_FILE = "0031_per_account_credit_floor.sql";

function migrationSql(): string {
  return readFileSync(resolve(process.cwd(), "migrations", MIGRATION_FILE), "utf8");
}

/** Recreates the pre-migration shape the file must cut over. */
const REINSTATE_COLUMN =
  'ALTER TABLE "provider_routing_settings" ADD COLUMN IF NOT EXISTS "credit_floor" integer';

dbDescribe("migration: per-account credit floor cutover", () => {
  test("adds account columns, backfills, and drops the provider column", async () => {
    await withRollback(async (client) => {
      await client.query(REINSTATE_COLUMN);
      const runId = `creditfloor-${Date.now().toString(36)}`;
      const providerId = `cutover-${runId}`;
      await client.query(`insert into providers (id, enabled) values ($1, true)`, [providerId]);
      const tenant = await client.query(
        `insert into tenants (name, status) values ($1, 'active') returning id`,
        [`cutover-${runId}`],
      );
      const tenantRow = tenant.rows[0];
      if (!tenantRow) throw new Error("tenant insert returned no row");
      const tenantId = tenantRow.id as string;
      const accounts = await client.query<{ id: string }>(
        `insert into provider_accounts
           (provider_id, tenant_id, label, credential_kind, status, cooldown_until, model_cooldowns)
         values ($1, $2, 'a1', 'oauth', 'active', null, '{}'),
                ($1, $2, 'a2', 'oauth', 'active', null, '{}')
         returning id`,
        [providerId, tenantId],
      );
      const withOwnFloor = accounts.rows[0]?.id;
      const inheritsFloor = accounts.rows[1]?.id;
      if (!withOwnFloor || !inheritsFloor) throw new Error("account insert returned no rows");
      // One account already has its own floor; the backfill must preserve it.
      await client.query(
        `update provider_accounts set min_credit_balance = 10 where id = $1`,
        [withOwnFloor],
      );
      await client.query(
        `insert into provider_routing_settings (provider_id, tenant_id, strategy, enabled, credit_floor)
         values ($1, null, 'fallback', false, 100)`,
        [providerId],
      );

      await client.query(migrationSql());
      await client.query(migrationSql());

      const columns = await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_name = $1 and column_name in ('min_credit_balance', 'last_remaining_credit', 'credit_floor')`,
        ["provider_accounts"],
      );
      expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
        "last_remaining_credit",
        "min_credit_balance",
      ]);
      const providerColumns = await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_name = 'provider_routing_settings' and column_name = 'credit_floor'`,
      );
      expect(providerColumns.rows.length).toBe(0);

      const own = await client.query<{ min_credit_balance: number }>(
        `select min_credit_balance from provider_accounts where id = $1`,
        [withOwnFloor],
      );
      expect(own.rows[0]?.min_credit_balance).toBe(10);
      const inherited = await client.query<{ min_credit_balance: number }>(
        `select min_credit_balance from provider_accounts where id = $1`,
        [inheritsFloor],
      );
      expect(inherited.rows[0]?.min_credit_balance).toBe(100);
    });
  });
});
