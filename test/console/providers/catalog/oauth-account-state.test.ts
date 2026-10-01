import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb, type CartethyiaDatabase } from "../../../../src/persistence/postgres";
import { dbDescribe } from "../../../helpers/db-gate";
import { providerAccounts, providerOauthStates, providers, tenants } from "../../../../src/persistence/schema";
import { DrizzleProviderCatalogStore, parsePastedOAuthCredential } from "../../../../src/console/providers/catalog/store";
import { createDefaultProviderRegistry } from "../../../../src/providers/default-registry";
import { decryptCredentialToString } from "../../../../src/security/crypto";

function storeOptions() {
  return {
    telemetryBuffer: {} as never,
    bundledModelCatalog: { modelsByProvider: new Map() },
    providerRegistry: createDefaultProviderRegistry(),
    outboundFetchFor: () => (async () => new Response("{}")) as never,
    snapshotInvalidator: { invalidate: async () => 0 },
  };
}

describe("parsePastedOAuthCredential", () => {
  test("a bare access token is its own access token with no separate refresh", () => {
    const parts = parsePastedOAuthCredential("sk-ant-oat01-bare");
    expect(parts.accessToken).toBe("sk-ant-oat01-bare");
    // Equal access/refresh is the signal the caller uses to detect "no refresh
    // token": it must not be stored as one.
    expect(parts.refreshToken).toBe(parts.accessToken);
    expect(parts.expiresAt).toBeUndefined();
  });

  test("a JSON export splits access, refresh, and expiry", () => {
    const parts = parsePastedOAuthCredential(
      JSON.stringify({
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: "2026-10-01T12:00:00.000Z",
      }),
    );
    expect(parts.accessToken).toBe("access-1");
    expect(parts.refreshToken).toBe("refresh-1");
    expect(parts.expiresAt?.toISOString()).toBe("2026-10-01T12:00:00.000Z");
  });

  test("snake_case fields and nested data are read", () => {
    const parts = parsePastedOAuthCredential(
      JSON.stringify({ data: { access_token: "a", refresh_token: "r", expires_at: 1790000000000 } }),
    );
    expect(parts.accessToken).toBe("a");
    expect(parts.refreshToken).toBe("r");
    expect(parts.expiresAt?.getTime()).toBe(1790000000000);
  });

  test("an epoch-seconds expiry is widened to milliseconds", () => {
    const parts = parsePastedOAuthCredential(
      JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: 1790000000 }),
    );
    expect(parts.expiresAt?.getTime()).toBe(1790000000 * 1000);
  });
});

dbDescribe("OAuth account creation always seeds a refreshable state row", () => {
  let db: CartethyiaDatabase;
  let store: DrizzleProviderCatalogStore;
  const tenantId = randomUUID();
  const providerId = "claude";

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleProviderCatalogStore(db, storeOptions());
    await db.insert(tenants).values({ id: tenantId, name: "oauth-state-test", status: "active" }).onConflictDoNothing();
    await db.insert(providers).values({ id: providerId, tenantId: null, enabled: true }).onConflictDoNothing();
  });

  afterAll(async () => {
    const accts = await db
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(eq(providerAccounts.tenantId, tenantId));
    const ids = accts.map((a) => a.id);
    if (ids.length > 0) {
      await db.delete(providerOauthStates).where(inArray(providerOauthStates.providerAccountId, ids));
      await db.delete(providerAccounts).where(inArray(providerAccounts.id, ids));
    }
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  test("a pasted JSON OAuth credential stores its refresh token in the state row", async () => {
    const account = await store.createAccount(tenantId, providerId, {
      credentialKind: "oauth",
      secret: JSON.stringify({ accessToken: "acc-json", refreshToken: "ref-json" }),
    });
    const [state] = await db
      .select()
      .from(providerOauthStates)
      .where(eq(providerOauthStates.providerAccountId, account.id));
    // The regression this guards: before the fix the row was never written for
    // a non-MiMo provider, so the sweep (an inner join) never saw the account.
    expect(state).toBeDefined();
    expect(decryptCredentialToString(state!.refreshCiphertext!)).toBe("ref-json");
  });

  test("a bare access token still gets a state row, flagged as a static token", async () => {
    const account = await store.createAccount(tenantId, providerId, {
      credentialKind: "oauth",
      secret: "bare-access-only",
    });
    const [state] = await db
      .select()
      .from(providerOauthStates)
      .where(eq(providerOauthStates.providerAccountId, account.id));
    // Visible to the sweep, but with no refresh token on record.
    expect(state).toBeDefined();
    expect(state!.refreshCiphertext).toBeNull();

    const [row] = await db
      .select({
        staticToken: providerAccounts.staticToken,
        category: providerAccounts.lastErrorCategory,
        status: providerAccounts.status,
      })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, account.id));
    // Flagged as a static token — the credential is used exactly as issued and
    // never refreshed — NOT as an error state. The account stays active and
    // dispatchable; the console shows an informational pill, not "re-login
    // required".
    expect(row?.staticToken).toBe(true);
    expect(row?.category).toBeNull();
    expect(row?.status).toBe("active");
  });
});
