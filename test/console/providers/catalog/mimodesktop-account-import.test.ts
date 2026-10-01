import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getDb, type CartethyiaDatabase } from "../../../../src/persistence/postgres";
import { DrizzleProviderCatalogStore } from "../../../../src/console/providers/catalog/store";
import { providerAccounts, providerOauthStates, providers, tenants } from "../../../../src/persistence/schema";
import { eq, inArray } from "drizzle-orm";
import { dbDescribe } from "../../../helpers/db-gate";
import { decryptCredentialToString } from "../../../../src/security/crypto";
import { createDefaultProviderRegistry } from "../../../../src/providers/default-registry";

function storeOptions() {
  return {
    telemetryBuffer: {} as never,
    bundledModelCatalog: { modelsByProvider: new Map() },
    providerRegistry: createDefaultProviderRegistry(),
    outboundFetchFor: () => (async () => new Response("{}")) as never,
    snapshotInvalidator: { invalidate: async () => 0 },
  };
}

dbDescribe("mimodesktop account creation with passToken state seeding", () => {
  let db: CartethyiaDatabase;
  let store: DrizzleProviderCatalogStore;
  const tenantId = randomUUID();

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleProviderCatalogStore(db, storeOptions());
    await db.insert(tenants).values({ id: tenantId, name: "mimo-test-tenant", status: "active" });
    await db.insert(providers).values({ id: "mimodesktop", tenantId: null, enabled: true }).onConflictDoNothing();
  });

  afterAll(async () => {
    const accts = await db.select({ id: providerAccounts.id }).from(providerAccounts).where(eq(providerAccounts.tenantId, tenantId));
    const ids = accts.map((a) => a.id);
    if (ids.length > 0) {
      await db.delete(providerOauthStates).where(inArray(providerOauthStates.providerAccountId, ids));
      await db.delete(providerAccounts).where(inArray(providerAccounts.id, ids));
    }
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  test("pasting auth.json stores passToken and seeds provider_oauth_states", async () => {
    const authJson = JSON.stringify({
      xiaomi: {
        type: "oauth",
        passToken: "mimo-passtoken-test-123",
        userId: "6691605628",
      },
    });

    const account = await store.createAccount(tenantId, "mimodesktop", {
      label: "My MiMo Desktop",
      credentialKind: "oauth",
      secret: authJson,
    });

    expect(account.providerId).toBe("mimodesktop");
    expect(account.credentialKind).toBe("oauth");

    const rows = await db
      .select()
      .from(providerAccounts)
      .innerJoin(providerOauthStates, eq(providerOauthStates.providerAccountId, providerAccounts.id))
      .where(eq(providerAccounts.id, account.id));

    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(decryptCredentialToString(row.provider_accounts.credentialCiphertext!)).toContain("mimo-passtoken-test-123");
    expect(decryptCredentialToString(row.provider_oauth_states.refreshCiphertext!)).toBe("mimo-passtoken-test-123");
  });
});
