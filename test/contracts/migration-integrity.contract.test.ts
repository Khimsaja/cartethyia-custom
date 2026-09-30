import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const migrationsDir = resolve(import.meta.dir, "../../migrations");

async function numberedMigrations(): Promise<string[]> {
  return (await readdir(migrationsDir))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
}

describe("SQL migration integrity", () => {
  test("the baseline is the first auto-applied migration", async () => {
    const files = await numberedMigrations();
    // The baseline comes first; future 0001+ migrations follow it.
    expect(files[0]).toBe("0000_baseline.sql");
    const migration = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    expect(migration.trim().length).toBeGreaterThan(0);
  });

  test("every migration after the baseline is idempotent", async () => {
    // The ledger skips an applied file, but a file that fails midway leaves no
    // ledger row and is retried on the next boot, so each must converge when
    // re-run. Guards: `IF NOT EXISTS`, `IF EXISTS`, or an `EXCEPTION` block.
    for (const file of await numberedMigrations()) {
      if (file === "0000_baseline.sql") continue; // the baseline creates the schema
      const migration = await readFile(resolve(migrationsDir, file), "utf8");
      const guarded =
        /IF NOT EXISTS|IF EXISTS|EXCEPTION WHEN|DO \$/.test(migration);
      expect({ file, guarded }).toEqual({ file, guarded: true });
    }
  });


  test("baseline carries no child-process pool columns, indexes, or checks", async () => {
    // The child-process pool flavor (v2ray/wireproxy daemon) was removed, so
    // its runtime bookkeeping must not linger in the schema. `network_pools`
    // keeps only the in-process http/https/socks5 shape.
    const migration = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    expect(migration).not.toContain('"process_id"');
    expect(migration).not.toContain('"socks_port"');
    expect(migration).not.toContain('"runtime_status"');
    expect(migration).not.toContain("network_pools_socks_port_uidx");
    expect(migration).not.toContain("network_pools_runtime_status_idx");
    expect(migration).not.toContain("network_pools_runtime_status_check");
    expect(migration).not.toContain("network_pools_socks_port_check");
    // The enum matches `schema.ts`'s `networkPoolKind`, with no daemon kinds.
    expect(migration).toContain(
      'CREATE TYPE "public"."network_pool_kind" AS ENUM(\'http\', \'socks5\')',
    );
  });

  test("baseline carries no retired `degraded` health status", async () => {
    // `degraded` sat between "working" and "parked" and every consumer read it
    // differently — routing as a hard exclusion, the cooldown sweep as
    // recoverable, the console as a third badge. The two facts it mixed are now
    // stated by `cooldown` and `disabled`. A fresh database never needs the
    // label, and `0002` exists only to migrate a database that already has it,
    // so the baseline must declare the enum without it — otherwise a new
    // install starts from the shape `0002` was written to remove.
    const baseline = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    expect(baseline).toContain(
      `CREATE TYPE "public"."health_status" AS ENUM('active', 'cooldown', 'disabled')`,
    );
    expect(baseline).not.toContain("'degraded'");
  });

  test("baseline carries no orphan backup_status table", async () => {
    // `backup_status` was a single-row bookkeeping table with no Drizzle
    // definition, no reader, and no writer — it survived only in the baseline,
    // so a fresh install carried a table nothing could touch. It is gone from
    // the baseline, and this asserts it cannot come back.
    const migration = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    expect(migration).not.toContain('CREATE TABLE "backup_status"');
  });

  test("provider allowlist is absent from the baseline and dropped on upgrade", async () => {
    const baseline = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    const migration = await readFile(
      resolve(migrationsDir, "0005_remove_api_key_provider_allowlist.sql"),
      "utf8",
    );
    expect(baseline).not.toContain('"provider_allowlist"');
    expect(migration).toContain('DROP COLUMN IF EXISTS "provider_allowlist"');
  });

  test("existing share-link checks allow personal handoff links", async () => {
    const migration = await readFile(
      resolve(migrationsDir, "0006_allow_personal_handoff_links.sql"),
      "utf8",
    );
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS "share_links_kind_check"');
    expect(migration).toContain('ADD CONSTRAINT "share_links_kind_check"');
    expect(migration).toContain("CHECK (\"kind\" IN ('enroll', 'handoff'))");
  });

  test("the wire_family enum carries no retired `native` label", async () => {
    // `native` was never a protocol: it marked a row served by a bespoke
    // adapter (Cursor, Devin) that frames its own wire. Sitting in the same
    // enum as the real families made it an operator-selectable choice that
    // died inside the codec with an untyped error. The fact it carried now
    // lives on the provider declaration (`bespokeWire`), so the label must not
    // return to the baseline or to any forward migration's target enum.
    const baseline = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    expect(baseline).toContain(
      `CREATE TYPE "public"."wire_family" AS ENUM('chat', 'responses', 'messages')`,
    );
    expect(baseline).not.toContain("'native'");
  });

  test("baseline carries no unused network-pool health column", async () => {
    // `degraded_since` was never read or written; the health state machine
    // records transitions through `status`, `last_error_at`, `cooldown_until`,
    // and `last_recovered_at`. It must not return to the baseline.
    const migration = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    expect(migration).not.toContain('"degraded_since"');
  });

  test("baseline carries the share-link columns and token table", async () => {
    const migration = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    expect(migration).toContain('"key_prefix" text');
    expect(migration).toContain('"key_encrypted" bytea');
    expect(migration).toContain('"notes_title" text');
    expect(migration).toContain('"notes_subtitle" text');
    expect(migration).toContain('"notes_body" text');
    expect(migration).toContain('CREATE TABLE "share_links"');
    expect(migration).toContain('"token_hash" text NOT NULL');
    expect(migration).toContain('CREATE UNIQUE INDEX "share_links_token_hash_idx"');
    expect(migration).toContain('CREATE INDEX "idx_share_links_active"');
  });
  test("api-key share popup fields exist in baseline and upgrade migrations", async () => {
    const baseline = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    const migration = await readFile(resolve(migrationsDir, "0015_api_key_share_popup.sql"), "utf8");
    const imageMigration = await readFile(
      resolve(migrationsDir, "0016_api_key_share_popup_image.sql"),
      "utf8",
    );
    const enabledMigration = await readFile(
      resolve(migrationsDir, "0017_api_key_share_popup_enabled.sql"),
      "utf8",
    );
    for (const name of ["share_popup_title", "share_popup_body"]) {
      expect(baseline).toContain(`"${name}" text`);
      expect(migration).toContain(`ADD COLUMN IF NOT EXISTS "${name}" text`);
    }
    // The popup's action button was removed outright: neither the baseline nor
    // any migration may reintroduce its columns, and 0018 drops them for
    // databases created before the removal.
    const dropActionMigration = await readFile(
      resolve(migrationsDir, "0018_api_key_share_popup_drop_action.sql"),
      "utf8",
    );
    for (const name of ["share_popup_action_label", "share_popup_action_url"]) {
      expect(baseline).not.toContain(name);
      expect(dropActionMigration).toContain(`DROP COLUMN IF EXISTS "${name}"`);
    }
    // List ordering is an explicit integer index on each reorderable table, so
    // a list cannot shift when two rows share a created_at timestamp.
    const sortIndexMigration = await readFile(
      resolve(migrationsDir, "0019_list_sort_index.sql"),
      "utf8",
    );
    for (const table of ["api_keys", "model_combos", "model_aliases"]) {
      expect(sortIndexMigration).toContain(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "sort_index" integer`,
      );
    }
    expect(baseline).toContain('"sort_index" integer DEFAULT 0 NOT NULL');
    // Popup art is uploaded bytes, not a URL: the baseline and the follow-up
    // migration both declare the bytea column plus its mime, and the original
    // URL column is dropped rather than left behind as a dead key.
    expect(baseline).toContain('"share_popup_image" bytea');
    expect(baseline).toContain('"share_popup_image_mime" text');
    expect(imageMigration).toContain('ADD COLUMN IF NOT EXISTS "share_popup_image" bytea');
    expect(imageMigration).toContain('ADD COLUMN IF NOT EXISTS "share_popup_image_mime" text');
    expect(imageMigration).toContain('DROP COLUMN IF EXISTS "share_popup_image_url"');
    // The donation/information mode collapsed into a boolean on/off flag: the
    // baseline declares it directly and 0017 converts any existing mode rows.
    expect(baseline).toContain('"share_popup_enabled" boolean DEFAULT false NOT NULL');
    expect(enabledMigration).toContain('ADD COLUMN IF NOT EXISTS "share_popup_enabled" boolean');
    expect(enabledMigration).toContain('DROP COLUMN IF EXISTS "share_popup_mode"');
  });

  test("baseline is self-contained: it declares every column the schema reads", async () => {
    // The baseline is the complete schema for a new database. It must include
    // every column the application reads, regardless of which forward migration
    // added that column to an earlier installation.
    const migration = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");

    const networkPools = migration.match(/CREATE TABLE "network_pools" \(([\s\S]*?)\n\);/)?.[1] ?? "";
    expect(networkPools).toContain('"kind" "network_pool_kind" NOT NULL');
    // Added by 0020 on existing installs, so a new database must get it here.
    expect(networkPools).toContain('"egress_ip" text');
    expect(networkPools).toContain('"quota_bytes" bigint');

    const telemetryEvents =
      migration.match(/CREATE TABLE "telemetry_events" \(([\s\S]*?)\n\);/)?.[1] ?? "";
    expect(telemetryEvents).toContain('"error_origin" text');
    expect(telemetryEvents).toContain('"requested_effort" text');

    // The enum the column depends on must be declared here too, or the table
    // cannot be created.
    expect(migration).toContain('CREATE TYPE "public"."network_pool_kind" AS ENUM(\'http\', \'socks5\')');
  });

  test("baseline carries the studio-sessions table and index", async () => {
    const migration = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    expect(migration).toContain('CREATE TABLE "studio_sessions"');
    expect(migration).toContain('CREATE INDEX "studio_sessions_tenant_updated_idx"');
  });

  test("baseline widens stream telemetry timestamps to bigint", async () => {
    const migration = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    expect(migration).toContain('"first_content_delta_at_ms" bigint');
    expect(migration).toContain('"last_event_at_ms" bigint');
  });

  test("completion enum is present in the baseline SQL source of truth", async () => {
    const migration = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    expect(migration).toContain("CREATE TYPE \"public\".\"telemetry_source_surface\"");
    expect(migration).toContain("'completion'");
  });

  test("baseline uses ordinary indexed telemetry and no legacy pool UPDATEs", async () => {
    const migration = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    expect(migration).toContain("CREATE INDEX \"idx_telemetry_created_at\"");
    expect(migration).toContain("CREATE INDEX \"telemetry_payloads_request_id_idx\"");
    expect(migration).not.toContain("UPDATE \"network_pools\" SET \"status\"");
    expect(migration).not.toContain("PARTITION BY RANGE");
    expect(migration).not.toContain("pg_partman");
    expect(migration).not.toContain("pg_cron");
    expect(migration).not.toContain("cleanup_expired_telemetry_payloads");
  });

  test("telemetry_payloads is a typed file-ref index, never a jsonb body column", async () => {
    // Cutoff: captured bodies live only in on-disk frames. The Postgres row is
    // a typed reference so a body cannot be written into the table by accident.
    const baseline = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    const forward = await readFile(
      resolve(migrationsDir, "0014_telemetry_payload_typed_ref.sql"),
      "utf8",
    );
    expect(baseline).toContain('"storage" text NOT NULL');
    expect(baseline).toContain('"file" text NOT NULL');
    expect(baseline).toContain('"checksum" text NOT NULL');
    expect(baseline).toContain('CONSTRAINT "telemetry_payloads_storage_check"');
    expect(baseline).not.toContain('"request_body" jsonb');
    expect(forward).toContain('DROP COLUMN IF EXISTS "request_body"');
    expect(forward).toContain('ADD COLUMN IF NOT EXISTS "storage" text');
  });
});