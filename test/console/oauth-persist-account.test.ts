/**
 * Two OAuth accounts that share a display label are two accounts.
 *
 * Production failure (2026-11-09): every account of a Workspace batch was
 * named "Maryanto Sinaga", so the label-based fingerprint made each new login
 * replace the row the previous login had just created — the console toasted
 * "OAuth account connected" while the qoder total never moved.
 *
 * The fix: a login that carries a stable per-account id in `auth_state`
 * (Qoder stores its user id there) is keyed on that id first, and a legacy
 * row is only updated when its stored user id matches the login — otherwise
 * a new row is inserted.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  DrizzleOAuthAccountStore,
  oauthIdentityFingerprint,
} from "../../src/console/providers/oauth/routes";
import { getDb } from "../../src/persistence/boot";
import { getTestPool, testDatabaseUrl } from "../helpers/database";

const canRun =
  Boolean(testDatabaseUrl) && Boolean(process.env.CARTETHYIA_ENCRYPTION_KEY?.trim());
const maybeTest = canRun ? test : test.skip;
const runId = randomUUID().slice(0, 8);
const PROVIDER = "qoder";

const labelFor = (name: string) => `Maryanto Sinaga ${runId} ${name}`;

function exchange(label: string, overrides: { userId?: string; access: string; refresh: string }) {
  return {
    label,
    access: overrides.access,
    refresh: overrides.refresh,
    expiresAt: new Date(Date.now() + 3600_000),
    ...(overrides.userId === undefined
      ? {}
      : { auth_state: { userId: overrides.userId, machineId: "test-machine" } }),
  };
}

async function rowsFor(label: string) {
  const pool = await getTestPool();
  const res = await pool.query<{ id: string; credential_fingerprint: string | null }>(
    "select id, credential_fingerprint from provider_accounts where provider_id = $1 and label = $2 order by created_at",
    [PROVIDER, label],
  );
  return res.rows;
}

beforeAll(async () => {
  if (!canRun) return;
  const pool = await getTestPool();
  // provider_accounts.provider_id references providers(id); seed the row the
  // same way the other console suites do. It is shared catalog data, so it is
  // intentionally left in place by afterAll.
  await pool.query(
    "insert into providers (id, wire_family_default, base_url) values ('qoder', 'chat', 'https://api2.qoder.sh') on conflict (id) do nothing",
  );
});

afterAll(async () => {
  if (!canRun) return;
  const pool = await getTestPool();
  await pool.query("delete from provider_accounts where provider_id = $1 and label like $2", [
    PROVIDER,
    `Maryanto Sinaga ${runId}%`,
  ]);
});

maybeTest("two logins with the same label but different user ids are two rows", async () => {
  const label = labelFor("two-accounts");
  const store = new DrizzleOAuthAccountStore(getDb());
  const first = await store.persistAccount(
    null,
    PROVIDER,
    exchange(label, { userId: `user-a-${runId}`, access: "dt-a1", refresh: "drt-a1" }),
  );
  const second = await store.persistAccount(
    null,
    PROVIDER,
    exchange(label, { userId: `user-b-${runId}`, access: "dt-b1", refresh: "drt-b1" }),
  );
  expect(second.accountId).not.toBe(first.accountId);
  expect((await rowsFor(label)).map((row) => row.id).sort()).toEqual(
    [first.accountId, second.accountId].sort(),
  );
});

maybeTest("a re-login of the same user id replaces its own row", async () => {
  const label = labelFor("relogin");
  const store = new DrizzleOAuthAccountStore(getDb());
  const first = await store.persistAccount(
    null,
    PROVIDER,
    exchange(label, { userId: `user-c-${runId}`, access: "dt-c1", refresh: "drt-c1" }),
  );
  const second = await store.persistAccount(
    null,
    PROVIDER,
    exchange(label, { userId: `user-c-${runId}`, access: "dt-c2", refresh: "drt-c2" }),
  );
  expect(second.accountId).toBe(first.accountId);
  expect(await rowsFor(label)).toHaveLength(1);
});

maybeTest("a legacy label-keyed row is only updated by its own user id", async () => {
  const label = labelFor("legacy");
  const pool = await getTestPool();
  const store = new DrizzleOAuthAccountStore(getDb());
  // A pre-patch row: fingerprint is the label hash, but auth_state already
  // holds the Qoder user id (the device flow always stored it).
  const legacy = await store.persistAccount(
    null,
    PROVIDER,
    exchange(label, { userId: `user-legacy-${runId}`, access: "dt-legacy1", refresh: "drt-legacy1" }),
  );
  const legacyFingerprint = oauthIdentityFingerprint({
    label,
    providerId: PROVIDER,
    access: "dt-legacy1",
    refresh: "drt-legacy1",
    expiresAt: new Date(0),
  });
  await pool.query(
    "update provider_accounts set credential_fingerprint = $1 where id = $2",
    [legacyFingerprint, legacy.accountId],
  );

  // Another account with the same name must NOT overwrite the legacy row.
  const other = await store.persistAccount(
    null,
    PROVIDER,
    exchange(label, { userId: `user-other-${runId}`, access: "dt-other1", refresh: "drt-other1" }),
  );
  expect(other.accountId).not.toBe(legacy.accountId);
  const afterOther = await rowsFor(label);
  expect(afterOther).toHaveLength(2);
  expect(afterOther.find((row) => row.id === legacy.accountId)?.credential_fingerprint).toBe(
    legacyFingerprint,
  );

  // The legacy account's own re-login updates its row and migrates the
  // fingerprint onto the stable identity.
  const again = await store.persistAccount(
    null,
    PROVIDER,
    exchange(label, { userId: `user-legacy-${runId}`, access: "dt-legacy2", refresh: "drt-legacy2" }),
  );
  expect(again.accountId).toBe(legacy.accountId);
  const afterAgain = await rowsFor(label);
  expect(afterAgain).toHaveLength(2);
  expect(afterAgain.find((row) => row.id === legacy.accountId)?.credential_fingerprint).not.toBe(
    legacyFingerprint,
  );
});
